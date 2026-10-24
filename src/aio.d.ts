export {};

declare global {
  interface Window {
    aio: {
      /** System UI language mapped to a supported locale (undefined outside Electron). */
      initialLocale?: 'zh' | 'en';
      /** True when a saved map session file already exists. */
      hasSession: boolean;
      setTitle(title: string): void;
      openFile(): Promise<string | null>;
      saveFile(name: string, text: string): Promise<boolean>;
      readSession(name: string): Promise<string | null>;
      writeSession(name: string, text: string): Promise<boolean>;
      exportSession(data: unknown): Promise<boolean>;
      onSessionExport(handler: () => void): void;
      onSessionImport(handler: (text: string) => void): void;
      onShowAbout(handler: () => void): void;
    };
  }
}
