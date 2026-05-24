import 'bootstrap/dist/css/bootstrap.min.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ToastProvider } from './toast';
import { ConfirmProvider } from './confirm';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('signalk-updater-server: #root element missing in index.html');

createRoot(rootEl).render(
  <StrictMode>
    <ToastProvider>
      <ConfirmProvider>
        <App />
      </ConfirmProvider>
    </ToastProvider>
  </StrictMode>,
);
