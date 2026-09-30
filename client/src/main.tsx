import React from 'react';
import ReactDOM from 'react-dom/client';
import '@mantine/core/styles.css';
import App from './App';
import FigmaHomePreview from './components/FigmaHomePreview';
import './figma-preview.css';
import './visual-foundation.css';
import { AuthProvider } from './context/AuthContext';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element not found');

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <AuthProvider>
      {new URLSearchParams(window.location.search).get('design-preview') === '1' ? <FigmaHomePreview /> : <App />}
    </AuthProvider>
  </React.StrictMode>,
);
