import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { openAIProvider } from './provider.mjs';
import { subscriptionCapabilities } from './model-router.mjs';

const safeEnvironment = source => Object.fromEntries(Object.entries(source).filter(([key, value]) =>
  typeof value === 'string' && /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|USERPROFILE|HOME|APPDATA|LOCALAPPDATA|TEMP|TMP|CODEX_HOME)$/i.test(key)));
const disabledFeatures = ['shell_tool', 'unified_exec', 'apps', 'plugins', 'hooks', 'browser_use', 'computer_use', 'multi_agent', 'image_generation', 'in_app_browser', 'skill_search', 'view_image', 'workspace_dependencies'];
const failure = message => new Error(message);

function runProcess(executable, args, { cwd, env, input = '', signal }) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    let child, text = '', settled = false, killTimer;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(killTimer); signal.removeEventListener('abort', abort); error ? reject(error) : resolve(value); };
    const abort = () => { if (child) { child.kill(); killTimer=setTimeout(()=>child.kill('SIGKILL'),1500); killTimer.unref(); } };
    try { child = spawn(executable, args, { cwd, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { return finish(failure('Codex CLI를 시작하지 못했습니다. 설치와 CODEX_CLI_PATH 설정을 확인해 주세요.')); }
    signal.addEventListener('abort', abort, { once: true });
    child.once('error', () => finish(failure('Codex CLI를 시작하지 못했습니다. 설치와 CODEX_CLI_PATH 설정을 확인해 주세요.')));
    const collect = chunk => { if (text.length < 16384) text += chunk.toString().slice(0, 16384 - text.length); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.once('close', code => finish(signal.aborted ? signal.reason : null, { code, text }));
    child.stdin.on('error', () => {}); child.stdin.end(input);
    if (signal.aborted) abort();
  });
}

/** Use the installed official CLI's own ChatGPT login; never read or copy tokens. */
export function createCodexRequest({ executable = process.env.CODEX_CLI_PATH || 'codex', model = process.env.CODEX_MODEL,
  env = process.env, timeoutMs = 300000, temporaryRoot = tmpdir(), runner = runProcess } = {}) {
  if (model !== undefined && model !== '' && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(model)) throw failure('CODEX_MODEL 모델 ID를 확인해 주세요.');
  if (typeof executable !== 'string' || !executable.trim()) throw failure('CODEX_CLI_PATH를 확인해 주세요.');
  return async function requestJson(instructions, input, signal, schema, _name, context = {}) {
    const timeout = AbortSignal.timeout(Math.max(1000, Math.min(Number(timeoutMs) || 300000, 600000)));
    const activeSignal = AbortSignal.any([...(signal ? [signal] : []), timeout]);
    const childEnv = safeEnvironment(env), temporaryDirectory = await fs.mkdtemp(path.join(path.resolve(temporaryRoot), 'launchpad-codex-'));
    try {
      const login = await runner(executable, ['login', 'status'], { cwd: temporaryDirectory, env: childEnv, signal: activeSignal });
      if (login.code !== 0 || !/logged in using chatgpt/i.test(login.text)) throw failure('구독 실행에는 이 컴퓨터의 Codex CLI에서 ChatGPT 로그인이 필요합니다. codex login 상태를 확인해 주세요.');
      const schemaFile = path.join(temporaryDirectory, 'response.schema.json'), outputFile = path.join(temporaryDirectory, 'response.json');
      await fs.writeFile(schemaFile, JSON.stringify(schema));
      // Only known reasoning-capable models (or the current CLI built-in default) receive role effort overrides.
      const supportsEffort = !model || /^(gpt-6(?:[.-])|gpt-5(?:[.-]))/.test(model);
      const effort = supportsEffort ? ({planner:'medium',coder:'medium',debugger:'high'})[context.role] : null;
      const args = ['exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only',
        '--color', 'never', '--output-schema', schemaFile, '-o', outputFile, '-c', 'web_search="disabled"',
        ...disabledFeatures.flatMap(feature => ['--disable', feature]), ...(model ? ['--model', model] : []), ...(effort ? ['-c',`model_reasoning_effort="${effort}"`] : []), '-'];
      const result = await runner(executable, args, { cwd: temporaryDirectory, env: childEnv, signal: activeSignal,
        input: `${instructions}\n\nReturn only the JSON object matching the supplied schema. All required context is below. Do not run tools, inspect files, or modify the filesystem.\n\n${input}` });
      if (result.code !== 0) throw failure('Codex 구독 실행을 완료하지 못했습니다. 로그인, 구독 한도, 네트워크와 Codex CLI 상태를 확인해 주세요.');
      const info = await fs.stat(outputFile).catch(() => null);
      if (!info || info.size < 2 || info.size > 2000000) throw failure('Codex가 유효한 크기의 구조화된 결과를 반환하지 않았습니다.');
      let parsed;try { parsed = JSON.parse(await fs.readFile(outputFile, 'utf8')); }
      catch { throw failure('Codex 응답이 올바른 JSON 형식이 아닙니다.'); }
      await context.onModelUsed?.({stage:context.stage,capability:context.capability,model:model||null,status:'completed',detail:`Codex ${model?'설정 모델':'CLI 기본 모델'}로 작업을 완료했습니다.${effort?` 추론 수준: ${effort}.`:''}`});
      return parsed;
    } catch (error) {
      await context.onModelUsed?.({stage:context.stage,capability:context.capability,model:model||null,status:'failed',detail:'Codex 구독 작업에 실패했습니다. API 키나 다른 모델로 자동 대체하지 않습니다.'});
      if (activeSignal.aborted) throw failure(signal?.aborted ? 'Codex 구독 실행이 취소되었습니다.' : 'Codex 구독 실행 시간이 초과되었습니다.');
      throw error;
    } finally {
      if (path.dirname(temporaryDirectory) === path.resolve(temporaryRoot) && path.basename(temporaryDirectory).startsWith('launchpad-codex-')) await fs.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
    }
  };
}

export function codexProvider(options = {}) {
  const provider = openAIProvider({ requestJson: createCodexRequest(options), env:{} });
  provider.capabilities = async () => subscriptionCapabilities(options.model || process.env.CODEX_MODEL || null);
  return provider;
}
