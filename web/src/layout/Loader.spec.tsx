import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Loader } from './Loader';

// Vitest runs without `globals: true`, so @testing-library/react never registers its
// auto-cleanup — without this the first test's DOM leaks into the second.
afterEach(cleanup);

describe('Loader', () => {
  it('renders the default label and is announced as a status', () => {
    render(<Loader />);
    const el = screen.getByRole('status');
    expect(el.textContent).toContain('loading…');
    expect(el.querySelector('.spinner')).not.toBeNull();
  });

  it('accepts a custom label', () => {
    render(<Loader label="loading tracks…" />);
    expect(screen.getByRole('status').textContent).toContain('loading tracks…');
  });
});
