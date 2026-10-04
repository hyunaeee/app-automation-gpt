package __APPLICATION_ID__;

import android.app.Activity;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/** Bundled, offline content only. No native JavaScript bridge or network permission. */
public final class MainActivity extends Activity {
    private static final String HOST = "appassets.androidplatform.net";
    private WebView webView;

    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.rgb(17, 18, 25));
        getWindow().setNavigationBarColor(Color.rgb(17, 18, 25));
        webView = new WebView(this);
        webView.setBackgroundColor(Color.rgb(17, 18, 25));
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        CookieManager.getInstance().setAcceptCookie(false);
        webView.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !isLocal(request.getUrl());
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return !isLocal(Uri.parse(url));
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return content(request.getUrl(), request.getMethod());
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, String url) {
                return content(Uri.parse(url), "GET");
            }
        });
        setContentView(webView);
        webView.loadUrl("https://" + HOST + "/index.html");
    }

    private boolean isLocal(Uri uri) {
        return "https".equals(uri.getScheme()) && HOST.equals(uri.getHost())
            && (uri.getPort() == -1 || uri.getPort() == 443) && uri.getUserInfo() == null;
    }

    private WebResourceResponse content(Uri uri, String method) {
        if (!isLocal(uri) || !"GET".equals(method)) return blocked(403, "Forbidden");
        String path = uri.getPath();
        if (path == null || path.equals("/")) path = "/index.html";
        if (!path.matches("/[A-Za-z0-9_./-]+") || path.contains("..") || path.contains("//")) {
            return blocked(403, "Forbidden");
        }
        Map<String, String> headers = new HashMap<>();
        headers.put("X-Content-Type-Options", "nosniff");
        headers.put("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; worker-src 'none'");
        try {
            return new WebResourceResponse(mime(path), "UTF-8", 200, "OK", headers,
                getAssets().open("web" + path));
        } catch (IOException ignored) {
            return blocked(404, "Not Found");
        }
    }

    private WebResourceResponse blocked(int status, String reason) {
        return new WebResourceResponse("text/plain", "UTF-8", status, reason,
            new HashMap<String, String>(), new ByteArrayInputStream(new byte[0]));
    }

    private String mime(String path) {
        String lower = path.toLowerCase(Locale.ROOT);
        if (lower.endsWith(".html")) return "text/html";
        if (lower.endsWith(".js")) return "application/javascript";
        if (lower.endsWith(".css")) return "text/css";
        if (lower.endsWith(".json")) return "application/json";
        if (lower.endsWith(".svg")) return "image/svg+xml";
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".webp")) return "image/webp";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        if (lower.endsWith(".gif")) return "image/gif";
        if (lower.endsWith(".woff2")) return "font/woff2";
        return "text/plain";
    }

    @Override public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override protected void onDestroy() {
        if (webView != null) { webView.destroy(); webView = null; }
        super.onDestroy();
    }
}
