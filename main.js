document.getElementById('generate-audiobook').addEventListener('click', generateAudiobook);

console.log("Version 0.9.1");

async function mergeAudioBlobsAndDownload(audioBlobs) {
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const buffers = [];

    // Decode MP3 blobs into AudioBuffers
    for (const blob of audioBlobs) {
        const arrayBuffer = await blob.arrayBuffer();
        const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
        buffers.push(audioBuffer);
    }

    // Convert AudioBuffers to WAV and concatenate
    const wavBuffers = buffers.map(buffer => audioBufferToWAV(buffer));
    const concatenatedWav = concatenateWAVBuffers(wavBuffers);

    // Trigger download of concatenated WAV file
    triggerDownload(new Blob([concatenatedWav], {type: 'audio/wav'}), 'merged_audio.wav');
}

function audioBufferToWAV(buffer) {
    // Convert an AudioBuffer to a WAV Blob using audiobuffer-to-wav
    return audioBufferToWav(buffer);
}

function concatenateWAVBuffers(wavBuffers) {
    // Extract and sum the lengths of the data chunks (excluding headers)
    const dataLength = wavBuffers.reduce((acc, buffer) => acc + (buffer.byteLength - 44), 0);

    // Create a new buffer to hold the concatenated WAV file
    const concatenatedBuffer = new Uint8Array(44 + dataLength);

    // Copy the header from the first buffer (44 bytes)
    concatenatedBuffer.set(new Uint8Array(wavBuffers[0].slice(0, 44)));

    // Update the total file size field in the header (4 bytes after "RIFF")
    const totalSize = 36 + dataLength;
    concatenatedBuffer[4] = (totalSize & 0xff);
    concatenatedBuffer[5] = ((totalSize >> 8) & 0xff);
    concatenatedBuffer[6] = ((totalSize >> 16) & 0xff);
    concatenatedBuffer[7] = ((totalSize >> 24) & 0xff);

    // Update the total data chunk size field (4 bytes after "data")
    const dataSize = dataLength;
    concatenatedBuffer[40] = (dataSize & 0xff);
    concatenatedBuffer[41] = ((dataSize >> 8) & 0xff);
    concatenatedBuffer[42] = ((dataSize >> 16) & 0xff);
    concatenatedBuffer[43] = ((dataSize >> 24) & 0xff);

    // Concatenate the actual data chunks
    let offset = 44;

    var progressBar = document.getElementById('progressbar2');
    progressBar.max = totalSize;
    progressBar.value = offset;

    wavBuffers.forEach(buffer => {
        concatenatedBuffer.set(new Uint8Array(buffer.slice(44)), offset);
        offset += buffer.byteLength - 44;
        progressBar.value = offset;
    });
    console.log("Individual buffer sizes:", wavBuffers.map(b => b.byteLength));
    console.log("Concatenated buffer size:", concatenatedBuffer.byteLength);


    return concatenatedBuffer.buffer;
}


function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
}


function generateAudiobook() {
    var text = document.getElementById('text-input').value;
    var apiKey = document.getElementById('api-key').value;
    var segments = splitTextIntoSegments(text, 4000);
    var audioBlobs = new Array(segments.length);
    var progressBar = document.getElementById('progressbar1');
	document.getElementById('error-indicator').style.display = 'none';
    progressBar.max = segments.length;
    progressBar.value = 0;

    // Queue for segment processing
    var queue = segments.slice(); // Clone the segments array
    var rateLimitPerMinute = 50;
    var delayBetweenCalls = 60000 / rateLimitPerMinute; // Delay in ms

    function writeString(view, offset, string) {
        for (var i = 0; i < string.length; i++) {
            view.setUint8(offset + i, string.charCodeAt(i));
        }
    }

    function processQueue() {
        if (queue.length === 0) return; // Stop if the queue is empty
        var index = segments.length - queue.length;
        var segment = queue.shift(); // Get the next segment from the queue
        
        if (segment.match(/\n{2,}/)) {
            var silentDuration = (segment.match(/\n/g).length - 1) * 0.25; // 0.25 seconds of silence per double newline
            var sampleRate = 44100;
            var numChannels = 2;
            var bitsPerSample = 16;
            var dataSize = Math.floor(silentDuration * sampleRate * numChannels * bitsPerSample / 8);
            
            var buffer = new ArrayBuffer(44 + dataSize);
            var view = new DataView(buffer);
            
            // RIFF identifier
            writeString(view, 0, 'RIFF');
            // file length
            view.setUint32(4, 36 + dataSize, true);
            // RIFF type
            writeString(view, 8, 'WAVE');
            // format chunk identifier
            writeString(view, 12, 'fmt ');
            // format chunk length
            view.setUint32(16, 16, true);
            // sample format (raw)
            view.setUint16(20, 1, true);
            // channel count
            view.setUint16(22, numChannels, true);
            // sample rate
            view.setUint32(24, sampleRate, true);
            // byte rate
            view.setUint32(28, sampleRate * numChannels * bitsPerSample / 8, true);
            // block align
            view.setUint16(32, numChannels * bitsPerSample / 8, true);
            // bits per sample
            view.setUint16(34, bitsPerSample, true);
            // data chunk identifier
            writeString(view, 36, 'data');
            // data chunk length
            view.setUint32(40, dataSize, true);
            
            audioBlobs[index] = new Blob([view], { type: 'audio/wav' });
            progressBar.value = audioBlobs.filter(Boolean).length;
            
            setTimeout(processQueue, delayBetweenCalls); // Process the next segment after a delay
        } else {
            callOpenAIAPI(segment, apiKey, function (audioBlob) {
                audioBlobs[index] = audioBlob;
                progressBar.value = audioBlobs.filter(Boolean).length;
                if (audioBlobs.filter(Boolean).length === segments.length) {
                    // All segments are loaded, merge them!
                    mergeAudioBlobsAndDownload(audioBlobs);
                } else {
                    setTimeout(processQueue, delayBetweenCalls); // Process the next segment after a delay
                }
            });
        }
    }

    // Start processing the queue
    processQueue();
}

function splitTextIntoSegments(text, maxLength) {
    var segments = [];
    var currentSegment = '';
    text.split(/(\n{2,})/).forEach(part => {
        if (part.match(/\n{2,}/)) {
            if (currentSegment.trim() !== '') {
                segments.push(currentSegment);
                currentSegment = '';
            }
            segments.push(part);
        } else {
            var sentences = part.split('. ');
            sentences.forEach(sentence => {
                if (currentSegment.length + sentence.length > maxLength) {
                    segments.push(currentSegment);
                    currentSegment = '';
                }
                currentSegment += sentence + '. ';
            });
        }
    });
    // Add the last segment if it's not empty
    if (currentSegment.trim() !== '') {
        segments.push(currentSegment);
    }
    return segments;
}

function callOpenAIAPI(segment, apiKey, callback) {
    var xhr = new XMLHttpRequest();
    xhr.open("POST", "https://api.openai.com/v1/audio/speech", true);
    xhr.setRequestHeader("Authorization", "Bearer " + apiKey);
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.responseType = 'blob'; // Expect a binary response

    xhr.onload = function () {
        if (xhr.status === 200) {
            var audioBlob = xhr.response;
            callback(audioBlob);
        } else {
            console.error("Error calling OpenAI API: " + xhr.statusText);
			document.getElementById('error-indicator').style.display = 'block';
        }
    };

    console.log("TTS running for: ");
    console.log(segment);

    var data = JSON.stringify({
        "model": document.getElementById("model").value,
        "input": segment,
        "voice": document.getElementById("voice").value
    });
    xhr.send(data);
}


document.addEventListener('DOMContentLoaded', function () {
    var textInput = document.getElementById('text-input');
    var fileUpload = document.getElementById('file-upload');
    var costDisplay = document.getElementById('cost-estimate-display');
    var modelSelect = document.getElementById('model');

    fileUpload.addEventListener('change', handleFileUpload);
    textInput.addEventListener('input', calculateCost);
    modelSelect.addEventListener('change', calculateCost);

    function calculateCost() {
        var textLength = textInput.value.length;
        if (document.getElementById("model").value == "tts-1") {
            var cost = (textLength / 1000) * 0.015;
        } else {
            var cost = (textLength / 1000) * 0.030;
        }
        
        costDisplay.textContent = 'Estimated Cost for Conversion: $' + cost.toFixed(2);
    }

    function handleFileUpload(event) {
        var file = event.target.files[0];
        if (file) {
            if (file.type === 'text/plain') {
                var reader = new FileReader();
                reader.onload = function (e) {
                    textInput.value = e.target.result;
                    calculateCost();
                };
                reader.readAsText(file);
            } else if (file.name.endsWith('.epub')) {
                var reader = new FileReader();
                reader.onload = function (e) {
                    var epubContent = e.target.result;
                    readEpub(epubContent);
                };
                reader.readAsBinaryString(file);
            } else {
                alert('Please upload a text or ePub file.');
            }
        }
    }

    function readEpub(epubContent) {
        var new_zip = new JSZip();
        new_zip.loadAsync(epubContent)
            .then(function (zip) {
                Object.keys(zip.files).forEach(function (filename) {
                    if (!(filename.includes("cover") || filename.includes("toc") || filename.includes("nav")) && filename.endsWith('html')) {
                        zip.files[filename].async('string').then(function (content) {
                            var text = extractTextFromHTML(content);
                            document.getElementById('text-input').value += removeWhitespace(filterUnwantedContent(text)) + '\n';
                            calculateCost();
                        });
                    }
                });
            });
    }

    function extractTextFromHTML(htmlContent) {
        var tempDiv = document.createElement('div');
        tempDiv.innerHTML = htmlContent;

        // Remove elements with epub:type="pagebreak"
        var pageBreaks = tempDiv.querySelectorAll('[epub\\:type="pagebreak"]');
        pageBreaks.forEach(function (elem) {
            elem.parentNode.removeChild(elem);
        });

        return tempDiv.textContent || tempDiv.innerText || '';
    }


    function filterUnwantedContent(text) {
        // Remove page numbers and bibliographies
        // Adjust these regex patterns as needed based on the actual content structure
        var filteredText = text.replace(/Page_[0-9]+\s*[0-9]+/g, ''); // Remove page numbers
        filteredText = filteredText.replace(/BIBLIOGRAPHY[\s\S]*?INTRODUCTORY/g, ''); // Remove bibliography section

        return filteredText;
    }

    function removeWhitespace(text) {
        return text.replace(/\s+/g, ' ').trim();
    }
});
