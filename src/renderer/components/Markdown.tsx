import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import styles from './Markdown.module.css';

/**
 * Renders assistant message text as Markdown.
 *
 * CSP-safe: react-markdown builds a React tree (no dangerouslySetInnerHTML),
 * rehype-highlight only adds class names (highlight.js tokens, styled in
 * styles/highlight.css), and no raw HTML is parsed (no rehype-raw). Links are
 * left as normal anchors — the Electron main process intercepts navigation and
 * opens http(s) externally, so a click can't escape the renderer.
 */
export function Markdown({ text }: { text: string }) {
  return (
    <div className={styles.prose}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{
          a: ({ node: _node, ...props }) => <a {...props} rel="noreferrer" />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
