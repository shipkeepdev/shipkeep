// Applies the saved theme before the page is painted. Loaded without defer, on purpose. The page is
// dark unless the visitor chose light; the key changed on 2026-11-23, so an older choice is forgotten.
try {
  if (localStorage.getItem('shipkeep-theme-v2') === 'light')
    document.documentElement.setAttribute('data-theme', 'light');
} catch {
  // Storage can be blocked: the page stays dark.
}
