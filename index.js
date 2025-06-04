// Handle uncaught exceptions and unhandled promise rejections to prevent process exit
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    // Optionally: notify a Discord channel or log to a file
    // Do not exit the process
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    // Optionally: notify a Discord channel or log to a file
    // Do not exit the process
});

const fs = require('node:fs');
const path = require('node:path');
// Require the necessary discord.js classes
const { Client, Collection, Events, GatewayIntentBits, AttachmentBuilder} = require('discord.js');
const { token, printers } = require('./config.json');

const { BambuClient } = require('bambu-node');
const { captureSingleFrameFromPrinter } = require("./BambuCamera.js"); // Assuming this is robust


const { getGcodeSettings } = require('./bambu-node-gcode-retriever.js');

// Create a new client instance
const client = new Client({ intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
] });

client.commands = new Collection();

const foldersPath = path.join(__dirname, 'commands');
const commandFolders = fs.readdirSync(foldersPath);

for (const folder of commandFolders) {
	const commandsPath = path.join(foldersPath, folder);
	const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));
	for (const file of commandFiles) {
		const filePath = path.join(commandsPath, file);
		const command = require(filePath);
		// Set a new item in the Collection with the key as the command name and the value as the exported module
		if ('data' in command && 'execute' in command) {
			client.commands.set(command.data.name, command);
		} else {
			console.log(`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`);
		}
	}
}



async function initalizePrinter(printer) {
    const bambu = new BambuClient({
        host: printer.PRINTER_IP,
        serialNumber: printer.PRINTER_SERIAL,
        accessToken: printer.ACCESS_CODE,
    });
    
    const channelID = "1372738672943828993";
    const channel = client.channels.cache.get(channelID);
    channel.send(`Hello! Bot is now observing ${printer.MACHINE_NAME}! 👋`);

    let reconnectAttempts = 0;
    const maxReconnectAttempts = 10;
    const reconnectDelay = 5000; // 5 seconds

    async function tryReconnect() {
        if (reconnectAttempts >= maxReconnectAttempts) {
            channel.send(`❌ Could not reconnect to ${printer.MACHINE_NAME} after ${maxReconnectAttempts} attempts.`);
            return;
        }
        reconnectAttempts++;
        channel.send(`⚠️ Lost connection to ${printer.MACHINE_NAME}. Attempting to reconnect (${reconnectAttempts}/${maxReconnectAttempts})...`);
        try {
            await bambu.connect();
            channel.send(`✅ Reconnected to ${printer.MACHINE_NAME}!`);
            reconnectAttempts = 0;
        } catch (err) {
            setTimeout(tryReconnect, reconnectDelay);
        }
    }

    let firstUpdate = true;

    bambu.on("printer:statusUpdate", async (oldStatus, newStatus) => {
        if (firstUpdate) {
            firstUpdate = false;
            return;
        }
        console.log(`getGcodeSettings: Printer status changed from ${oldStatus} to ${newStatus}!`);

        channel.send(`${printer.MACHINE_NAME} is now ${newStatus}`);

        if (newStatus != "FAILED" && newStatus != "RUNNING" && newStatus != "PAUSE" && newStatus != "FINISH") return;


        const settingsToQuery = "total estimated time;default_filament_profile;filament used [g]";
        const extractedSettings = await getGcodeSettings(settingsToQuery, 40000, printer);

        console.log(extractedSettings);
        
        let messageText = "Couldn't retrieve print files...";
        let imageAttachment;

        
        if (typeof extractedSettings === 'object' && extractedSettings !== null) { 

            // Extract Image
            const tempImageDir = path.join(__dirname, 'printer_images_temp'); 
            let imagePathForCleanup = await captureSingleFrameFromPrinter(
                printer.PRINTER_IP,
                printer.ACCESS_CODE,
                { outputDir: tempImageDir, timeoutMs: 25000 }
            );

            if (imagePathForCleanup) {
                // console.log(`[${new Date().toISOString()}] SUCCESS: Initial image for ${printerKey} saved at ${imagePathForCleanup}`);
                const uniqueAttachmentName = `${path.basename(imagePathForCleanup, '.jpg')}_initial_${Date.now()}.jpg`;
                imageAttachment = new AttachmentBuilder(imagePathForCleanup, { name: uniqueAttachmentName });

            }

            // Create Message Payload
            const fileName = extractedSettings["original_printer_filename"] || "N/A";
            const printerStatus = extractedSettings["printer_gcode_state"] || "N/A"; // This is the gcode_state
            const printTime = extractedSettings["total estimated time"] || "N/A"; // Assuming array, take first
            const filamentType = extractedSettings["default_filament_profile"] || "N/A";
            const filamentUsed = extractedSettings["filament used [g]"] || "N/A";

            messageText = "```\n" +
                            `Printer: ${printer.MACHINE_NAME}\n` +
                            `File Name: ${fileName}\n` +
                            `Status: ${printerStatus}\n\n` +
                            `Est. Print Time: ${printTime}\n` +
                            `Filament Type: ${filamentType}\n` +
                            `Filament Used: ${filamentUsed}g\n` +
                            "```";

            if (imageAttachment === null) {
                messageText += "\n(Could not retrieve printer camera image for initial display)";
            }

        } else {
            
        }
        const messagePayload = { content: messageText }; // Not ephemeral so button stays        

        if (imageAttachment) {
            messagePayload.files = [imageAttachment];
        }
        
        const sentMessageID = await channel.send(messagePayload);
        // const messageToEdit = await channel.cache.get(sentMessageID);


    });

    bambu.on('error', (err) => {
        console.error(`[BambuClient] Error for ${printer.MACHINE_NAME}:`, err);
        // tryReconnect();
    });

    bambu.on('closed', () => {
        console.warn(`[BambuClient] Connection closed for ${printer.MACHINE_NAME}`);
        // tryReconnect();
    });

    bambu.connect();
}

// When the client is ready, run this code (only once).
client.once(Events.ClientReady, readyClient => {
	console.log(`Ready! Logged in as ${readyClient.user.tag}`);

    initalizePrinter(printers.P1P);
    initalizePrinter(printers.P1S);
});

client.on(Events.MessageCreate, async message => {

    if (message.author.bot) return;

    if (message.mentions.users.has(client.user.id)) {
        try {
            await message.reply(`Hi <@${message.author.id}>!`);
        } catch(err) {
            console.log("Ping Feedback Error: " + err);
        }
    }


})

client.on(Events.InteractionCreate, async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const command = interaction.client.commands.get(interaction.commandName);

    if (!command) {
        console.error(`No command matching ${interaction.commandName} was found.`);
        return;
    }

    try {
        await command.execute(interaction);
    } catch (error) {
        console.error(error);
        if (interaction.replied || interaction.deferred) {
            await interaction.followUp({ content: 'There was an error while executing this command!', flags: MessageFlags.Ephemeral });
        } else {
            await interaction.reply({ content: 'There was an error while executing this command!', flags: MessageFlags.Ephemeral });
        }
    }
});


// Log in to Discord with your client's token
client.login(token);






const SETTINGS_TO_QUERY = "total estimated time;filament_type;";
const TIMEOUT_MS = 90000; // 90 seconds

async function fetchAndDisplayGcodeSettings() {
    console.log(`Attempting to retrieve G-code settings for: "${SETTINGS_TO_QUERY}"`);
    console.log(`Timeout set to: ${TIMEOUT_MS / 1000} seconds`);

    try {
        // Call the imported function
        const extractedSettings = await getGcodeSettings(SETTINGS_TO_QUERY, TIMEOUT_MS);

        if (extractedSettings) {
            console.log("\n--- Successfully Retrieved G-code Settings ---");
            // Iterate over the keys provided in the query to maintain order and check for all.
            SETTINGS_TO_QUERY.split(';').forEach(requestedKey => {
                const normalizedKey = requestedKey.trim().toLowerCase().replace(/\s+/g, ' ');
                if (extractedSettings[normalizedKey] && extractedSettings[normalizedKey].length > 0) {
                    console.log(`  ${normalizedKey}: ${extractedSettings[normalizedKey].join(', ')}`);
                } else {
                    console.log(`  ${normalizedKey}: Not found or no value.`);
                }
            });

            // Example of accessing a specific setting directly from the result:
            const totalTimeArray = extractedSettings["total estimated time"];
            if (totalTimeArray && totalTimeArray.length > 0) {
                console.log(`\n  Direct access example - Total Estimated Time: ${totalTimeArray[0]}`);
            }

        } else {
            console.log("\n--- Could not retrieve G-code settings. ---");
            console.log("This could be due to a timeout (no relevant print job found in time),");
            console.log("an MQTT/FTP error, the G-code file not being found on the printer,");
            console.log("or the specific settings not being present in the G-code file.");
        }
    } catch (error) {
        console.error("\n--- An error occurred while trying to get G-code settings ---");
        if (error instanceof Error) {
            console.error("Error message:", error.message);
            if (error.stack) {
                console.error("Stack trace:", error.stack);
            }
        } else {
            console.error("An unknown error occurred:", error);
        }
    } finally {
        console.log("\n--- Invocation script finished ---");
        // If this script is meant to be a one-off utility,
        // you might want to explicitly exit the process,
        // as the getGcodeSettings function itself tries to clean up its MQTT client.
        // However, Node.js should exit automatically if all async operations complete.
        // process.exit(0); // Uncomment if you need to force exit.
    }
}

// Run the main function
// fetchAndDisplayGcodeSettings();
