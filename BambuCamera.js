const tls = require('tls');
const { Buffer } = require('buffer');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path'); // For constructing file paths

const JPEG_START_MARKER = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const JPEG_END_MARKER = Buffer.from([0xff, 0xd9]);

class PrinterCameraNode extends EventEmitter {
    constructor(hostname, accessCode, port = 6000, username = 'bblp', options = {}) {
        super();
        this.hostname = hostname;
        this.accessCode = String(accessCode);
        this.port = port;
        this.username = username;
        this.options = {
            frameProcessingMode: 'single', // Hardcoded to single for this specific function's purpose
            timeoutMs: 30000, // Default timeout for the capture operation
            ...options
        };

        this.lastFrameData = null;
        this.alive = false;
        this.socket = null;
        this.reconnectTimeout = null;
        this.currentFrameBuffer = Buffer.alloc(0);
        this.expectedPayloadSize = 0;
        this.isReceivingImage = false;
        this.connectAttempts = 0;
        this.operationTimeout = null; // For the overall operation
        this.hasResolvedOrRejected = false; // Prevent multiple resolves/rejects
    }

    _buildAuthData() {
        const authBuffer = Buffer.alloc(80); // 4*4 (headers) + 32 (user) + 32 (pass)
        let offset = 0;

        authBuffer.writeUInt32LE(0x40, offset); offset += 4;
        authBuffer.writeUInt32LE(0x3000, offset); offset += 4;
        authBuffer.writeUInt32LE(0, offset); offset += 4;
        authBuffer.writeUInt32LE(0, offset); offset += 4;

        const userBytes = Buffer.from(this.username, 'ascii');
        userBytes.copy(authBuffer, offset);
        offset += userBytes.length;
        for (let i = userBytes.length; i < 32; i++) {
            authBuffer.writeUInt8(0x00, offset++);
        }

        const accessCodeBytes = Buffer.from(this.accessCode, 'ascii');
        accessCodeBytes.copy(authBuffer, offset);
        offset += accessCodeBytes.length;
        for (let i = accessCodeBytes.length; i < 32; i++) {
            authBuffer.writeUInt8(0x00, offset++);
        }
        return authBuffer;
    }

    start(resolve, reject) { // Pass resolve and reject for the promise
        if (this.alive) {
            console.warn("Camera connection attempt already in progress or active.");
            // In a promise context, this might mean an issue with how it's called
            if (reject && !this.hasResolvedOrRejected) {
                this.hasResolvedOrRejected = true;
                reject(new Error("Camera connection attempt already in progress."));
            }
            return false;
        }
        this.alive = true;
        this.hasResolvedOrRejected = false;
        console.log(`Starting camera connection to ${this.hostname} (mode: ${this.options.frameProcessingMode}).`);

        // Setup overall operation timeout
        if (this.options.timeoutMs > 0) {
            this.operationTimeout = setTimeout(() => {
                if (!this.hasResolvedOrRejected) {
                    const errMsg = `Operation timed out after ${this.options.timeoutMs / 1000} seconds for ${this.hostname}.`;
                    console.error(errMsg);
                    this.hasResolvedOrRejected = true;
                    this.stop(); // Ensure cleanup
                    if (reject) reject(new Error(errMsg));
                }
            }, this.options.timeoutMs);
        }

        this._connect(resolve, reject);
        return true;
    }

    stop() {
        this.alive = false;
        if (this.operationTimeout) {
            clearTimeout(this.operationTimeout);
            this.operationTimeout = null;
        }
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }
        if (this.socket) {
            console.log(`Destroying socket for ${this.hostname}...`);
            this.socket.destroy();
            this.socket = null;
        }
        console.log(`Camera client stopped for ${this.hostname}.`);
        this.emit('stopped');
    }


    _connect(resolve, reject) {
        if (!this.alive) {
            if (reject && !this.hasResolvedOrRejected) {
                this.hasResolvedOrRejected = true;
                reject(new Error("Connection attempt aborted, camera is not alive."));
            }
            return;
        }

        this.connectAttempts++;
        console.log(`Attempting to connect to ${this.hostname} (attempt ${this.connectAttempts})...`);

        const authData = this._buildAuthData();
        const tlsOptions = { host: this.hostname, port: this.port, rejectUnauthorized: false };

        this.socket = tls.connect(tlsOptions, () => {
            console.log(`TLS connection established to ${this.hostname}. Sending auth data.`);
            this.socket.write(authData);
            this.connectAttempts = 0;
            this.currentFrameBuffer = Buffer.alloc(0);
            this.isReceivingImage = false;
            this.expectedPayloadSize = 0;
        });

        this.socket.on('data', (data) => {
            if (!this.alive || this.hasResolvedOrRejected) return;

            this.currentFrameBuffer = Buffer.concat([this.currentFrameBuffer, data]);

            while (this.currentFrameBuffer.length > 0 && this.alive && !this.hasResolvedOrRejected) {
                if (!this.isReceivingImage) {
                    if (this.currentFrameBuffer.length >= 16) {
                        // Assuming 4-byte little-endian for payload size from the header's first bytes.
                        // For 3-byte (as in Python script): this.expectedPayloadSize = this.currentFrameBuffer[0] + (this.currentFrameBuffer[1] << 8) + (this.currentFrameBuffer[2] << 16);
                        this.expectedPayloadSize = this.currentFrameBuffer.readUInt32LE(0);
                        
                        console.debug(`Got header from ${this.hostname}. Payload size: ${this.expectedPayloadSize}`);
                        this.currentFrameBuffer = this.currentFrameBuffer.subarray(16);
                        this.isReceivingImage = true;
                        if (this.expectedPayloadSize === 0 || this.expectedPayloadSize > 15 * 1024 * 1024) { // Sanity check for size (e.g., max 15MB)
                            console.warn(`Invalid payload size from ${this.hostname}: ${this.expectedPayloadSize}. Resetting.`);
                            this.isReceivingImage = false;
                            this.currentFrameBuffer = Buffer.alloc(0);
                        }
                    } else { break; }
                }

                if (this.isReceivingImage) {
                    if (this.currentFrameBuffer.length >= this.expectedPayloadSize) {
                        const imageData = this.currentFrameBuffer.subarray(0, this.expectedPayloadSize);
                        this.currentFrameBuffer = this.currentFrameBuffer.subarray(this.expectedPayloadSize);
                        this.isReceivingImage = false;

                        if (imageData.length > 0 &&
                            imageData.subarray(0, JPEG_START_MARKER.length).equals(JPEG_START_MARKER) &&
                            imageData.subarray(imageData.length - JPEG_END_MARKER.length).equals(JPEG_END_MARKER)) {
                            
                            this.lastFrameData = imageData;
                            console.log(`Single frame captured from ${this.hostname}: ${this.lastFrameData.length} bytes`);
                            
                            if (!this.hasResolvedOrRejected) {
                                this.hasResolvedOrRejected = true; // Mark as processed
                                if (this.operationTimeout) clearTimeout(this.operationTimeout);
                                
                                // The promise is resolved by the calling function after saving
                                if (resolve) resolve(this.lastFrameData); // Resolve with raw image buffer
                            }
                            this.stop(); // Stop after capturing the single frame
                            return; 
                        } else if (imageData.length > 0) {
                            console.warn(`Received data slot from ${this.hostname}, but not a valid JPEG or empty.`);
                        }
                        this.expectedPayloadSize = 0;
                    } else { break; }
                }
            }
        });

        this.socket.on('error', (err) => {
            if (this.hasResolvedOrRejected && (err.code === 'ECONNRESET' || err.code === 'ERR_STREAM_DESTROYED')) {
                console.log(`Socket error for ${this.hostname} after processing, likely due to stop(): ${err.message}`);
                return;
            }
            console.error(`Socket error for ${this.hostname}: ${err.message}`);
            if (this.socket) this.socket.destroy();
            if (this.alive && !this.hasResolvedOrRejected) this._scheduleReconnect(resolve, reject);
            else if (!this.hasResolvedOrRejected) {
                this.hasResolvedOrRejected = true;
                if (reject) reject(err);
            }
        });

        this.socket.on('close', (hadError) => {
            console.log(`Connection to ${this.hostname} closed.${hadError ? " Due to an error." : ""}`);
            if (this.alive && !this.hasResolvedOrRejected) {
                this._scheduleReconnect(resolve, reject);
            } else if (!this.alive && !this.hasResolvedOrRejected && hadError) {
                 // If it was closed due to an error and we weren't expecting to be alive (e.g. after stop())
                 // but we haven't resolved/rejected the main promise yet.
                this.hasResolvedOrRejected = true;
                if (reject) reject(new Error(`Connection to ${this.hostname} closed unexpectedly with error.`));
            }
        });

        this.socket.setTimeout(20000); // Socket inactivity timeout
        this.socket.on('timeout', () => {
            console.warn(`Socket timeout for ${this.hostname}.`);
            if (this.socket) this.socket.destroy(); // This will trigger 'close' and potentially 'error'
            // Reconnect logic (if applicable) will be triggered by 'close' event
            // If this timeout happens before frame capture, the main operationTimeout should catch it.
        });
    }

    _scheduleReconnect(resolve, reject) {
        if (!this.alive || this.hasResolvedOrRejected) return;
        if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);

        // Limit reconnect attempts for a single operation promise
        if (this.connectAttempts > 2) { // Allow e.g. 3 total attempts (1 initial + 2 retries)
            const errMsg = `Failed to connect to ${this.hostname} after ${this.connectAttempts} attempts.`;
            console.error(errMsg);
            if (!this.hasResolvedOrRejected) {
                this.hasResolvedOrRejected = true;
                this.stop();
                if (reject) reject(new Error(errMsg));
            }
            return;
        }

        const delay = 3000; // Shorter delay for retries within a single operation
        console.log(`Reconnecting to ${this.hostname} in ${delay / 1000} seconds...`);
        this.reconnectTimeout = setTimeout(() => {
            this._connect(resolve, reject);
        }, delay);
    }
}

/**
 * Captures a single frame from a Bambu Lab printer.
 * @param {string} printerIp The IP address or hostname of the printer.
 * @param {string} accessCode The access code for the printer.
 * @param {object} [options] Optional parameters.
 * @param {number} [options.port=6000] The port number for the camera stream.
 * @param {string} [options.username='bblp'] The username for the camera stream.
 * @param {string} [options.outputDir=process.cwd()] Directory to save the image.
 * @param {number} [options.timeoutMs=30000] Timeout for the entire operation in milliseconds.
 * @returns {Promise<string>} A promise that resolves with the full path to the saved image, or rejects with an error.
 */
function captureSingleFrameFromPrinter(printerIp, accessCode, options = {}) {
    return new Promise((resolve, reject) => {
        const {
            port = 6000,
            username = 'bblp',
            outputDir = process.cwd(), // Default to current working directory
            timeoutMs = 30000
        } = options;

        if (!printerIp || !accessCode) {
            reject(new Error("Printer IP and Access Code are required."));
            return;
        }

        const camera = new PrinterCameraNode(printerIp, accessCode, port, username, {
            frameProcessingMode: 'single', // Ensure it's single
            timeoutMs: timeoutMs
        });

        // Internal promise resolve/reject are now passed to camera.start
        // and camera._connect to handle the image data or errors directly.
        camera.start(
            (imageBuffer) => { // This is the 'resolve' callback passed to camera.start
                try {
                    // Sanitize printerIp to create a valid filename
                    const safePrinterName = printerIp.replace(/[.:]/g, '_');
                    const outputFilename = `${safePrinterName}.jpg`;
                    const fullImagePath = path.resolve(outputDir, outputFilename);

                    // Ensure output directory exists
                    if (!fs.existsSync(outputDir)) {
                        fs.mkdirSync(outputDir, { recursive: true });
                    }

                    fs.writeFileSync(fullImagePath, imageBuffer);
                    console.log(`Frame from ${printerIp} successfully saved as ${fullImagePath}`);
                    resolve(fullImagePath); // Resolve the main promise with the path
                } catch (e) {
                    console.error(`Error saving frame from ${printerIp}:`, e);
                    reject(e); // Reject the main promise
                } finally {
                    camera.stop(); // Ensure camera is stopped
                }
            },
            (err) => { // This is the 'reject' callback passed to camera.start
                console.error(`Failed to capture frame from ${printerIp}:`, err.message);
                camera.stop(); // Ensure camera is stopped
                reject(err); // Reject the main promise
            }
        );
    });
}

// --- Example Usage ---
async function main() {
    const printerIp = ""; // <--- REPLACE THIS
    const accessCode = ""; // <--- REPLACE THIS

    if (printerIp === "your_printer_ip" || accessCode === "your_printer_access_code") {
        console.error("--------------------------------------------------------------------");
        console.error("IMPORTANT: Please update printerIp and accessCode in the example usage.");
        console.error("--------------------------------------------------------------------");
        return;
    }

    console.log(`Attempting to capture frame from ${printerIp}...`);
    try {
        const imagePath = await captureSingleFrameFromPrinter(printerIp, accessCode, {
            outputDir: path.join(__dirname, 'printer_images'), // Example: save in a subfolder
            timeoutMs: 45000 // Override default timeout if needed
        });
        console.log(`SUCCESS: Image saved at ${imagePath}`);
    } catch (error) {
        console.error(`FAILURE: Could not capture image from ${printerIp}. Error: ${error.message}`);
    }

    // Example with another printer (if you have one)
    // const printerIp2 = "another_printer_ip";
    // const accessCode2 = "another_access_code";
    // if (printerIp2 !== "another_printer_ip") {
    //     console.log(`\nAttempting to capture frame from ${printerIp2}...`);
    //     try {
    //         const imagePath2 = await captureSingleFrameFromPrinter(printerIp2, accessCode2);
    //         console.log(`SUCCESS: Image saved at ${imagePath2}`);
    //     } catch (error) {
    //         console.error(`FAILURE: Could not capture image from ${printerIp2}. Error: ${error.message}`);
    //     }
    // }
}

if (require.main === module) {
    main().catch(err => {
        // This catch is for unhandled errors in main itself, not typically for the promise rejections
        console.error("Critical error in main execution:", err);
    });
}

module.exports = { captureSingleFrameFromPrinter, PrinterCameraNode }; // Export both
