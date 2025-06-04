// bambu-node-gcode-retriever.js (Targeting CommonJS)

// Using require for CommonJS modules
const { BambuClient } = require('bambu-node');
const { Client } = require('basic-ftp');

const extract = require('extract-zip');

const path = require('path');
const fs = require('fs');

const { printers } = require('./config.json');


async function extractInfoFromGcode(gcodeFilePath, settingNamesQuery) {
    const foundSettings = {};
    const desiredSettings = settingNamesQuery.split(";");

    try {
        if (!fs.existsSync(gcodeFilePath)) {
            console.error(`  Error: G-code file not found at '${gcodeFilePath}'.`);
            return foundSettings;
        }
        const fileContent = fs.readFileSync(gcodeFilePath, 'utf-8');
        const lines = fileContent.split("; ")

        for (const line of lines) {
            for (const query of desiredSettings) {
                if (line.toLowerCase().includes(query.toLowerCase())) {
                    if (!foundSettings[query]) {
                        foundSettings[query] = [];
                    }

                    let key = "";
                    if (line.includes(": ")) {
                        key = line.split(": ")[1].replace(/\r?\n$/, '');
                    } else if (line.includes("= ")) {
                        key = line.split("= ")[1].replace(/\r?\n$/, '');
                    }

                    foundSettings[query].push(key);
                }
            }
        }
    } catch (error) {
        console.error(`  Error reading or processing g-code file '${gcodeFilePath}': ${error.message}`);
    }
    return foundSettings;
}

function downloadGCodeViaFTP(
    printFileName,
    printer,
) {
    return new Promise(async (resolve, reject) => {
        const client = new Client();
        client.ftp.verbose = true;

        try {
            await client.access({
                host: printer.PRINTER_IP,
                user: "bblp",
                password: printer.ACCESS_CODE,
                port: 990,
                secure: 'implicit',
                secureOptions: { rejectUnauthorized: false } 
            });
            const list = await client.list("/cache");

            console.log("--- ATTEMPTING DOWNLOAD ---");
            const downloadPath = path.join(__dirname, "downloads", `${printFileName}`);
            await client.downloadTo(
                downloadPath,
                `/cache/${printFileName}`
            );

            resolve(downloadPath);
        } catch(err) {
            console.log(err);
            reject(err);
        } finally {
            client.close();
        }
    });
}


async function getGcodeSettings(
    settingsToQuery,
    timeoutMs = 60000,
    printer
) {

    return new Promise(async (resolve) => {
        
        let bambu = null;

        const cleanupAndResolve = (value) => {
            // if (operationTimeoutId) clearTimeout(operationTimeoutId);
            if (bambu && typeof bambu.disconnect === 'function') {
                try { bambu.disconnect(); } catch (disconnectError) { /* ignore */ }
            }
            resolve(value);
        };

        bambu = new BambuClient({
            host: printer.PRINTER_IP,
            serialNumber: printer.PRINTER_SERIAL,
            accessToken: printer.ACCESS_CODE,
            port: 8883, 
        })

        console.log(`getGcodeSettings: Connecting to printer ${printer.MACHINE_NAME} for settings: "${settingsToQuery}"`);

        bambu.on('message', async (throwDeprecation, key, messageData) => { 

            if (messageData.msg != 0) return;

            const printInfo = messageData;

            const gcodeFileOnPrinter = printInfo.gcode_file;
            const subtaskName = printInfo.subtask_name; 
            // const taskNameFromMqtt = printInfo.task_name; // task_name from MQTT (might be undefined)
            const gcodeState = printInfo.gcode_state;

            console.log(subtaskName);

            // const currentTaskId = printInfo.task_id === undefined ? null : String(printInfo.task_id);
            // const printTypeFromMQTT = printInfo.print_type;

            if (typeof messageData === 'object' && messageData !== null && messageData.subtask_name !== null && (key === 'print')) { 
                if (gcodeState === "RUNNING" || gcodeState === "FINISH" || gcodeState === "FAILED" || gcodeState === "PAUSE") {
                    
                    downloadGCodeViaFTP(`${subtaskName}.3mf`, printer)
                        .then(async (zipFileDirectory) => {
                            console.log("--- FILE DOWNLOADED ---");
                            try {
                                console.log('--- ATTEMPING EXTRACTION ---');
                                await extract(zipFileDirectory, { dir: path.join(__dirname, "downloads", `${subtaskName}.gcode`)})
                                console.log('Extraction complete')
                                
                                let extractedSettings = await extractInfoFromGcode(path.join(__dirname, "downloads", `${subtaskName}.gcode`,"/Metadata/plate_1.gcode"), settingsToQuery)

                                fs.unlinkSync(path.join(__dirname, "downloads", `${subtaskName}.3mf`));
                                fs.rmSync(path.join(__dirname, "downloads", `${subtaskName}.gcode`), { recursive: true, force: true });

                                if (extractedSettings) {
                                    // Convert all fields to string (join arrays, stringify others)
                                    Object.keys(extractedSettings).forEach(key => {
                                        if (Array.isArray(extractedSettings[key])) {
                                            extractedSettings[key] = extractedSettings[key].join(', ');
                                        } else if (typeof extractedSettings[key] !== 'string') {
                                            extractedSettings[key] = String(extractedSettings[key]);
                                        }
                                    });
                                    extractedSettings["original_printer_filename"] = String(subtaskName || gcodeFileOnPrinter || subtaskName);
                                    extractedSettings["printer_gcode_state"] = String(gcodeState);
                                }
                                console.log(`  Successfully extracted settings for '${subtaskName}'.`);
                                cleanupAndResolve(extractedSettings);
                            } catch (err) {
                                // handle any errors
                                console.error(err);
                            }
                        })
                        .catch(err => {
                            console.error("Error downloading file:", err);
                        });
                }

            }
        })

        bambu.on('error', (err) => {

        })

        bambu.on('closed', () => {

        })

        try {
            if (typeof bambu.connect === 'function') {
                await bambu.connect();
                console.log(`getGcodeSettings: MQTT client connected to ${printer.PRINTER_SERIAL}. Waiting for print job info...`);
            } else {
                console.error("getGcodeSettings: BambuClient instance does not have a 'connect' method. Is 'bambu-node' installed correctly?");
                cleanupAndResolve(null);
            }
        } catch (error) {
            console.error(`getGcodeSettings: Failed to initiate MQTT connection to ${printer.PRINTER_SERIAL}:`, error); // Log full error
            cleanupAndResolve(null);
        }
    })

}


// TODO
exports.getGcodeSettings = getGcodeSettings;
// exports.extractInfoFromGcode = extractInfoFromGcode; 

async function selfTest() {
    console.log("---- Retrieve GCode Test ----")

    const printer = printers.P1P;
    const settingsToQuery = "total layer number;filament_type;max_z_height;total estimated time;first layer bed temperature;printing temperature";

    

    try {
        console.log(`\n[Self-Test] Calling getGcodeSettings for printer: ${printer.PRINTER_SERIAL}`);
        const settings = await getGcodeSettings(settingsToQuery, 90000, printer);

        if (settings) {
            console.log("\n--- Self-Test Result: Extracted G-code Settings ---");

            Object.entries(settings).forEach(([key, value]) => {
                if (Array.isArray(value)) {
                    console.log(`  ${key}: ${value.join(', ')}`);
                } else {
                    console.log(`  ${key}: ${value}`);
                }
            }); 
        } else {
            console.log("\n--- Self-Test Result: Could not retrieve settings. ---");
        }

    } catch(error) {
        console.error("Self Test Error --- ", error);
    } finally {
        console.log("\n---- Test Finished ----");
    }


}

if (require.main === module) {
    (async () => {
        const settingsToQuery = "total estimated time;default_filament_profile;filament used [g]";
        const settings = await getGcodeSettings(settingsToQuery, 90000, printers.P1S);

        // console.log("--- SETTINGS EXTRACTED ---");
        // console.log(settings);

        // const settings = await extractInfoFromGcode(path.join(__dirname, "/downloads/steer2v2test1(1).gcode.gcode/Metadata/plate_1.gcode"), settingsToQuery)
        console.log(settings);
    })();

    
}