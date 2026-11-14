import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installFeatGateConfig } from './core/feat-gate';
import './styles.scss';

// BEFORE anything renders or fetches: the http-gate bundle (app-infra slot) reads this
// global at load time — feature config is build-time data, never a runtime fetch.
installFeatGateConfig();

const container = document.getElementById('root');
if (!container) throw new Error('#root is missing from index.html');

createRoot(container).render(<App />);
