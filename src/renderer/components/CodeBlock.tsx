import { useMemo } from 'react';
import hljs from 'highlight.js/lib/common';
import styles from './CodeBlock.module.css';

/**
 * Syntax-highlighted code block for tool-call previews (read/bash/grep output).
 *
 * highlight.js escapes the input and only emits `<span class="hljs-*">`, so
 * dangerouslySetInnerHTML here is safe and CSP-compatible (no scripts). Tokens
 * are themed in styles/highlight.css against the design tokens.
 */

const EXT_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  css: 'css',
  scss: 'scss',
  html: 'xml',
  xml: 'xml',
  svg: 'xml',
  md: 'markdown',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cs: 'csharp',
  php: 'php',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  yaml: 'yaml',
  sql: 'sql',
  toml: 'ini',
  ini: 'ini',
};

function langFor(arg?: string): string | null {
  if (!arg) return null;
  const m = /\.([a-z0-9]+)\s*$/i.exec(arg.trim());
  if (!m || !m[1]) return null;
  return EXT_LANG[m[1].toLowerCase()] ?? null;
}

export function CodeBlock({ code, arg }: { code: string; arg?: string }) {
  const html = useMemo(() => {
    try {
      const lang = langFor(arg);
      if (lang && hljs.getLanguage(lang)) {
        return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
      }
      return hljs.highlightAuto(code).value;
    } catch {
      return null;
    }
  }, [code, arg]);

  if (html == null) {
    return (
      <pre className={styles.pre}>
        <code>{code}</code>
      </pre>
    );
  }
  return (
    <pre className={styles.pre}>
      {/* eslint-disable-next-line react/no-danger -- hljs output is escaped + class-only */}
      <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
    </pre>
  );
}
