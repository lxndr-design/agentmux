import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Markdown } from './markdown';

describe('Markdown', () => {
  it('renders headings at their level', () => {
    render(<Markdown text={'# Title\n## Section\n### Sub'} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Title');
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Section');
    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('Sub');
  });

  it('renders bold, italic, and inline code as elements', () => {
    render(<Markdown text="Fix the **bug** in *auth*, see `refresh()`" />);
    expect(screen.getByText('bug').closest('strong')).not.toBeNull();
    expect(screen.getByText('auth').closest('em')).not.toBeNull();
    expect(screen.getByText('refresh()').closest('code')).not.toBeNull();
  });

  it('renders fenced code blocks as pre>code without inline parsing', () => {
    render(<Markdown text={'```\nconst x = **not** markdown\n```'} />);
    const pre = screen.getByText('const x = **not** markdown').closest('pre');
    expect(pre).not.toBeNull();
    expect(pre?.querySelector('code')).not.toBeNull();
    expect(pre?.querySelector('strong')).toBeNull();
  });

  it('renders http(s) links and restricts hrefs to http(s)', () => {
    const { container } = render(
      <Markdown
        text={'[docs](https://example.com/a)\n[eevil](javascript:alert(1))\n[rel](ftp://x)'}
      />,
    );
    const links = container.querySelectorAll('a');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', 'https://example.com/a');
    expect(links[0]).toHaveAttribute('rel', 'noreferrer noopener');
    // Non-http schemes render as raw text, never as anchors.
    expect(container.textContent).toContain('javascript:alert(1)');
    expect(container.textContent).toContain('ftp://x');
  });

  it('renders unordered lists', () => {
    render(<Markdown text={'- one\n- two'} />);
    const list = screen.getByRole('list');
    expect(list.querySelectorAll('li')).toHaveLength(2);
  });

  it('never produces markup from injected HTML', () => {
    const { container } = render(
      <Markdown text={'<img src=x onerror="alert(1)"> & <script>alert(1)</script>'} />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    // The raw text survives as inert content.
    expect(container.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(container.textContent).toContain('<script>alert(1)</script>');
  });

  it('renders unclosed streaming markers as literal text', () => {
    const { container } = render(<Markdown text="starting **bold without end" />);
    expect(container.querySelector('p')?.textContent).toBe('starting **bold without end');
    expect(container.querySelector('strong')).toBeNull();
  });
});
