import { useEffect } from 'react';
import { piClient } from './client/pi-client.js';
import { Chat } from './components/Chat.js';
import { InspectorPane } from './components/InspectorPane.js';
import { Settings } from './components/Settings.js';
import { Sidebar } from './components/Sidebar.js';
import { StatusBar } from './components/StatusBar.js';
import { TitleBar } from './components/TitleBar.js';
import { TweaksPanel } from './components/TweaksPanel.js';
import { Welcome } from './components/Welcome.js';
import { useAgentStore } from './stores/agent.js';
import { useUiStore } from './stores/ui.js';
import styles from './App.module.css';

export function App() {
  const ready = useUiStore((s) => s.ready);
  const hydrate = useUiStore((s) => s.hydrate);
  const sidebarVisible = useUiStore((s) => s.sidebarVisible);
  const rightPane = useUiStore((s) => s.rightPane);
  const view = useUiStore((s) => s.view);
  const ensureSubscribed = useAgentStore((s) => s.ensureSubscribed);

  useEffect(() => {
    void hydrate();
    ensureSubscribed();
    // Pin the platform onto <html data-platform="…"> so CSS can hide
    // decorative traffic lights on macOS where the OS renders real ones.
    void piClient.meta().then((meta) => {
      document.documentElement.dataset['platform'] = meta.platform;
    });
  }, [hydrate, ensureSubscribed]);

  if (!ready) {
    return <div className={styles.bootShell} />;
  }

  // The right inspector is chat-only — Welcome and Settings own their full
  // content column.
  const showRight = view === 'chat' && rightPane !== 'none';

  const main =
    view === 'settings' ? <Settings /> : view === 'welcome' ? <Welcome /> : <Chat />;

  return (
    <div className={styles.shell}>
      <div className={styles.window}>
        <TitleBar />
        <div
          className={`${styles.body} ${sidebarVisible ? '' : styles.bodyNoSidebar} ${
            showRight ? styles.bodyWithRight : ''
          }`}
        >
          {sidebarVisible && <Sidebar />}
          {main}
          {showRight && <InspectorPane />}
        </div>
        <StatusBar />
      </div>
      <TweaksPanel />
    </div>
  );
}
