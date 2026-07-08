const DEFAULT_PREVIEW_HOST = '127.0.0.1';

export function previewHostForDevServerUrl(configuredUrl: string): string {
  try {
    const url = new URL(configuredUrl);
    return url.hostname === 'localhost' ? 'localhost' : DEFAULT_PREVIEW_HOST;
  } catch {
    return DEFAULT_PREVIEW_HOST;
  }
}
