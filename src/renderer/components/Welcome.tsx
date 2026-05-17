import { ArrowRight, BookOpen, Folder, Package, Sparkles } from 'lucide-react';
import { PiGlyph } from './PiGlyph.js';
import { useProjectsStore } from '../stores/projects.js';
import { useUiStore } from '../stores/ui.js';
import styles from './Welcome.module.css';

const CARDS = [
  {
    icon: Sparkles,
    title: 'Start a session here',
    desc: 'Chat with Pi in this repo — files, git, build tools all available.',
  },
  {
    icon: Folder,
    title: 'Open another folder',
    desc: 'Point Pi at any directory on disk. AGENTS.md is auto-loaded.',
  },
  {
    icon: Package,
    title: 'Install a package',
    desc: 'Sub-agents, plan mode, sandboxes — bring your own primitives.',
  },
  {
    icon: BookOpen,
    title: 'Read the docs',
    desc: 'Hotkeys, extensions API, RPC + SDK. Five-minute tour.',
  },
] as const;

export function Welcome() {
  const dismiss = useUiStore((s) => s.dismissWelcome);
  const recent = useProjectsStore((s) => s.projects[0] ?? null);

  return (
    <section className={styles.welcome} aria-label="Welcome">
      <header className={styles.header}>
        <span className={styles.pill}>
          <Sparkles size={10} /> Welcome
        </span>
        <span className={styles.spacer} />
        <button className={styles.skip} onClick={dismiss} type="button">
          Skip <ArrowRight size={12} />
        </button>
      </header>

      <div className={styles.body}>
        <div className={styles.card}>
          <div className={styles.logo}>
            <PiGlyph size={44} />
          </div>
          <h1 className={styles.title}>
            There are many agent harnesses,
            <br />
            <em>but this one is yours.</em>
          </h1>
          <p className={styles.lede}>
            Pi is a minimal coding harness. Adapt it to your workflows — not the other way around.
            Extensions, skills, prompts, and themes are just files in your repo.
          </p>

          <div className={styles.grid}>
            {CARDS.map((c) => {
              const Icon = c.icon;
              return (
                <button
                  key={c.title}
                  className={styles.startCard}
                  onClick={dismiss}
                  type="button"
                >
                  <span className={styles.startCardIcon}>
                    <Icon size={15} />
                  </span>
                  <span className={styles.startCardText}>
                    <span className={styles.startCardTitle}>{c.title}</span>
                    <span className={styles.startCardDesc}>{c.desc}</span>
                  </span>
                </button>
              );
            })}
          </div>

          <div className={styles.foot}>
            {recent ? (
              <>
                <span>Last opened</span>
                <span className={styles.mono}>{recent.name}</span>
                <span>·</span>
                <span className={styles.mono}>{recent.path}</span>
              </>
            ) : (
              <span>No projects yet — add a folder to begin</span>
            )}
            <span className={styles.spacer} />
            <span className={styles.kbd}>⌘O</span>
            <span>open</span>
          </div>

          <div className={styles.meta}>
            <span className={styles.metaItem}>
              <PiGlyph size={12} /> v0.1.0
            </span>
            <span>·</span>
            <span>15+ providers</span>
            <span>·</span>
            <span>MIT</span>
            <span>·</span>
            <span className={styles.metaLink}>pi.dev</span>
          </div>
        </div>
      </div>
    </section>
  );
}
