import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import '@fontsource-variable/dm-sans';
import '@fontsource-variable/noto-sans-kr';
import './styles.css';
import './components.css';
import './inner-pages.css';
import './model-connection.css';
import './creation-flow.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App /></React.StrictMode>,
);

import './mobile-studio.css';
import './workflow-review.css';
