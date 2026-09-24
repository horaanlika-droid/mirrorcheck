const emptyState = document.querySelector("#emptyState");
const mirrorFrame = document.querySelector("#mirrorFrame");
const mirrorStatus = document.querySelector("#mirrorStatus");
const mirrorStatusText = document.querySelector("#mirrorStatusText");

function showStatus(message) {
  mirrorStatusText.textContent = message;
  mirrorStatus.hidden = false;
}

function showEmptyState() {
  emptyState.hidden = false;
  mirrorFrame.hidden = true;
  mirrorFrame.removeAttribute("src");
  mirrorStatus.hidden = true;
}

function showTarget(targetUrl) {
  emptyState.hidden = true;
  mirrorFrame.hidden = false;
  mirrorFrame.src = targetUrl;
  showStatus("Тестовая страница загружается");
}

async function loadMirrorTarget() {
  try {
    const response = await fetch("/api/target", { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error("Target endpoint is unavailable");

    const payload = await response.json();
    if (payload.url) {
      showTarget(payload.url);
    } else {
      showEmptyState();
    }
  } catch {
    // The static preview remains useful without the optional bot server.
    showEmptyState();
  }
}

mirrorFrame.addEventListener("load", () => {
  if (!mirrorFrame.hidden) showStatus("Зеркало открыто");
});

loadMirrorTarget();
