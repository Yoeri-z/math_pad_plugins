type TextEntry = HTMLInputElement | HTMLTextAreaElement | HTMLElement;

/** Outcome of an insertion attempt, reported back to the background. */
export interface InsertResult {
  ok: boolean;
  /** Short explanation logged when `ok` is false. */
  reason?: string;
}

const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "submit",
  "checkbox",
  "radio",
  "file",
  "hidden",
  "range",
  "color",
]);

/**
 * Pastes text at the caret of the focused editor, as if it came from the
 * clipboard. Rich editors (Overleaf, Google Docs, AI chat composers) handle
 * this paste themselves and insert the text at the caret. Plain inputs and
 * textareas cannot receive synthetic pastes, so they get a direct splice.
 */
export function insertTextAtCaret(text: string): InsertResult {
  if (text.length === 0) {
    return fail("Text payload is empty");
  }
  const target = document.activeElement;
  if (!isTextEntry(target)) {
    return fail("No focused text field on this page");
  }
  if (isPlainInput(target)) {
    return spliceAtSelection(target, text)
      ? { ok: true }
      : fail("The focused field has no selection to insert at");
  }
  if (typeof DataTransfer === "undefined") {
    return fail("This browser does not support synthetic pastes");
  }

  const clipboard = new DataTransfer();
  clipboard.setData("text/plain", text);
  return pasteAtCaret(clipboard);
}

/**
 * Pastes an image into the focused editor as if it came from the clipboard.
 * Rich editors (Overleaf, Google Docs, AI chat composers) handle this paste
 * themselves and place the image at the caret.
 */
export function pasteImageAtCaret(base64: string, mimeType: string): InsertResult {
  if (typeof DataTransfer === "undefined") {
    return fail("This browser does not support synthetic pastes");
  }

  const clipboard = new DataTransfer();
  clipboard.items.add(imageFile(base64, mimeType));
  return pasteAtCaret(clipboard);
}

/** Dispatches a synthetic paste with `clipboard` to the focused element. */
function pasteAtCaret(clipboard: DataTransfer): InsertResult {
  const target = document.activeElement;
  if (!target) {
    return fail("No focused element to paste into");
  }
  if (typeof ClipboardEvent === "undefined") {
    return fail("This browser does not support synthetic pastes");
  }

  target.dispatchEvent(
    new ClipboardEvent("paste", {
      clipboardData: clipboard,
      bubbles: true,
      cancelable: true,
    }),
  );
  return { ok: true };
}

/**
 * Whether a caret-based paste can target this element. The element must accept
 * typed text and carry a caret: an input, textarea, or contenteditable.
 */
function isTextEntry(element: Element | null): element is TextEntry {
  if (!element) {
    return false;
  }
  if (element instanceof HTMLTextAreaElement) {
    return true;
  }
  if (element instanceof HTMLInputElement) {
    return !NON_TEXT_INPUT_TYPES.has(element.type);
  }
  return element instanceof HTMLElement && element.isContentEditable;
}

function isPlainInput(
  element: TextEntry,
): element is HTMLInputElement | HTMLTextAreaElement {
  return (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement
  );
}

/**
 * Replaces the selected range of a plain input or textarea with `text` and
 * moves the caret after it. Synthetic paste events never run the browser's
 * default action, so these fields need the value updated directly.
 */
function spliceAtSelection(
  element: HTMLInputElement | HTMLTextAreaElement,
  text: string,
): boolean {
  const { selectionStart, selectionEnd, value } = element;
  if (selectionStart === null || selectionEnd === null) {
    return false;
  }

  element.value =
    value.slice(0, selectionStart) + text + value.slice(selectionEnd);
  const caret = selectionStart + text.length;
  element.setSelectionRange(caret, caret);
  element.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
}

function imageFile(base64: string, mimeType: string): File {
  const bytes = base64ToBytes(base64);
  const extension = mimeType.split("/")[1]?.split("+")[0] || "png";
  return new File([bytes.buffer as ArrayBuffer], `mathpad.${extension}`, {
    type: mimeType,
  });
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function fail(reason: string): InsertResult {
  return { ok: false, reason };
}
