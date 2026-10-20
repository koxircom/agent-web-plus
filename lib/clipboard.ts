export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch { /* Restricted browsers may still allow copying during this user action. */ }
  }
  const previousFocus = document.activeElement;
  const ta = document.createElement("textarea");
  try {
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    if (!document.execCommand("copy")) throw new Error("浏览器未允许复制");
  } finally {
    ta.remove();
    if (previousFocus instanceof HTMLElement) previousFocus.focus({ preventScroll: true });
  }
}
