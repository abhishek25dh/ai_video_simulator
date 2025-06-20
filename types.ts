
export interface ContextualImageItem {
  pixabayUrl: string | null;        // URL of the image fetched from Pixabay
  userOverriddenUrl: string | null; // URL provided by the user as an override
  displayUrl: string | null;        // The actual URL to display (either from Pixabay or overridden)
}
