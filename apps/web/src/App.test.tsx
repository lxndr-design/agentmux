import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from './App';

describe('App', () => {
  it('renders the shell stub', () => {
    const html = renderToString(<App />);
    expect(html).toContain('agentmux');
    expect(html).toContain('One shell, many agents, one conscience');
  });
});
