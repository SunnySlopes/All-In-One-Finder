export {};

declare global {
  interface Window {
    /** Called by the native host on window close to persist the latest map session. */
    __AIO_SESSION_B64__?: () => string;
    aio: {
      /** System UI language mapped to a supported locale (undefined outside Electron). */
      initialLocale?: 'zh' | 'en';
      /** True when a saved map session file already exists. */
      hasSession: boolean;
      setTitle(title: string): void;
      /** Keep the native window caption in step with the in-page theme. */
      setTheme(theme: 'dark' | 'light'): void;
      openFile(): Promise<string | null>;
      saveFile(name: string, text: string): Promise<boolean>;
      readSession(name: string): Promise<string | null>;
      writeSession(name: string, text: string): Promise<boolean>;
      onShowAbout(handler: () => void): void;
    };
  }
}
