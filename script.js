const mirrorCamera = document.querySelector("#mirrorCamera");
const mirrorSurface = document.querySelector(".mirror-surface");
const cameraMessage = document.querySelector("#cameraMessage");
const cameraRetry = document.querySelector("#cameraRetry");

let cameraStream;

function stopCamera() {
  cameraStream?.getTracks().forEach((track) => track.stop());
  cameraStream = undefined;
  mirrorCamera.srcObject = null;
  mirrorCamera.classList.remove("is-ready");
  mirrorSurface.classList.remove("has-camera");
}

function showCameraUnavailable() {
  cameraMessage.textContent = "Камера недоступна — зеркало всё равно готово.";
  cameraRetry.hidden = false;
}

async function startCamera() {
  cameraRetry.hidden = true;
  cameraMessage.textContent = "";
  stopCamera();

  if (!navigator.mediaDevices?.getUserMedia) {
    showCameraUnavailable();
    return;
  }

  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: "user",
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
    });

    mirrorCamera.srcObject = cameraStream;
    await mirrorCamera.play();
    mirrorCamera.classList.add("is-ready");
    mirrorSurface.classList.add("has-camera");
  } catch {
    showCameraUnavailable();
  }
}

cameraRetry.addEventListener("click", startCamera);
window.addEventListener("pagehide", stopCamera);
startCamera();
