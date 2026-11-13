import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../agora-kit/fonts';
import { ThemeProvider } from '../agora-kit/theme';
import { App, DURABLE_ACCENT } from './App';
import '@xyflow/react/dist/style.css';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchInterval: 2000, refetchOnWindowFocus: false } },
});

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <ThemeProvider storageKey="agora-durable-theme" accent={DURABLE_ACCENT}>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
