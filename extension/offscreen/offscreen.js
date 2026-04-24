// Offscreen document — runs in background, has access to getUserMedia
let mediaRecorder = null;
let audioChunks = [];
let stream = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'offscreen') return;

  if (message.type === 'START_RECORDING') {
    startRecording(sendResponse);
    return true; // async
  }

  if (message.type === 'STOP_RECORDING') {
    stopRecording(sendResponse);
    return true; // async
  }
});

async function startRecording(sendResponse) {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];

    // Pick best supported format
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : 'audio/ogg';

    mediaRecorder = new MediaRecorder(stream, { mimeType });

    mediaRecorder.addEventListener('dataavailable', (e) => {
      if (e.data.size > 0) audioChunks.push(e.data);
    });

    mediaRecorder.start(100);
    sendResponse({ success: true });
  } catch (err) {
    sendResponse({ success: false, error: err.message });
  }
}

function stopRecording(sendResponse) {
  if (!mediaRecorder || mediaRecorder.state === 'inactive') {
    sendResponse({ success: false, error: 'Not recording' });
    return;
  }

  mediaRecorder.addEventListener('stop', async () => {
    // Stop all tracks
    if (stream) {
      stream.getTracks().forEach(t => t.stop());
      stream = null;
    }

    const mimeType = mediaRecorder.mimeType;
    const blob = new Blob(audioChunks, { type: mimeType });

    // Convert blob to base64 to send via message
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = reader.result.split(',')[1];
      sendResponse({ success: true, audio: base64, mimeType });
    };
    reader.readAsDataURL(blob);
  });

  mediaRecorder.stop();
}
