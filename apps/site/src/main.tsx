import React from 'react';
import { ClerkProvider } from '@clerk/react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App.tsx';
import { clerkPublishableKey, isClerkConfigured } from './lib/clerk.ts';
import './styles.css';
import { startTensolReveal } from './tns-anim.ts';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

const app = (
  <BrowserRouter>
    <App />
  </BrowserRouter>
);

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    {isClerkConfigured ? (
      <ClerkProvider publishableKey={clerkPublishableKey} afterSignOutUrl="/">
        {app}
      </ClerkProvider>
    ) : (
      app
    )}
  </React.StrictMode>,
);

startTensolReveal();
