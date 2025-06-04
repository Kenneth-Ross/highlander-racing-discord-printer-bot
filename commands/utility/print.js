const { ActionRowBuilder, SlashCommandBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const path = require('path');

const { printers } = require("../../config.json");
const { captureSingleFrameFromPrinter } = require("../../BambuCamera.js"); // Assuming this is robust
const { BambuClient } = require('bambu-node');

let getGcodeSettings;
try {
    const gcodeRetriever = require('../../bambu-node-gcode-retriever.js');
    if (gcodeRetriever && typeof gcodeRetriever.getGcodeSettings === 'function') {
        getGcodeSettings = gcodeRetriever.getGcodeSettings;
        console.log('Successfully imported getGcodeSettings from bambu-node-gcode-retriever.js');
    } else {
        console.error('Failed to import getGcodeSettings. It might not be exported correctly or the module is structured unexpectedly.');
        // getGcodeSettings will remain undefined, handled in execute
    }
} catch (error) {
    console.error('CRITICAL ERROR: Failed to require bambu-node-gcode-retriever.js. Path or module content issue.', error);
    // getGcodeSettings will remain undefined, handled in execute
}

// Map to store active BambuClient instances for alerts, keyed by interaction ID or message ID
const activeAlertClients = new Map();

module.exports = {
    data: new SlashCommandBuilder()
        .setName('print')
        .setDescription('Displays Current Print Job and allows setting an alert for status changes!')
        .addStringOption(option =>
            option.setName('printer')
                .setDescription('Select Printer')
                .setRequired(true)
                .addChoices( // Ensure your config.json has "P1S" and "P1P" keys in `printers`
                    { name: "BambuLab P1S", value: "P1S" },
                    { name: "BambuLab P1P", value: "P1  P" },
                )
        ),
    async execute(interaction) {
        if (typeof getGcodeSettings !== 'function') {
            console.error(`[${new Date().toISOString()}] Execute function called, but getGcodeSettings is not available.`);
            await interaction.reply({ content: 'Sorry, the print command is currently unavailable due to a configuration issue. Please contact the bot administrator.', ephemeral: true });
            return;
        }

        const printerKey = interaction.options.getString('printer');
        const printerConfig = printers[printerKey];

        if (!printerConfig) {
            console.error(`[${new Date().toISOString()}] Invalid printer key selected: ${printerKey}`);
            // No deferReply yet, so use regular reply
            await interaction.reply({ content: `Configuration for printer "${printerKey}" not found.`, ephemeral: true });
            return;
        }

        const alertButton = new ButtonBuilder()
            .setCustomId(`alert_status_${printerKey}`) // More unique customId
            .setLabel("🔔 Alert on Status Change")
            .setStyle(ButtonStyle.Primary);

        const row = new ActionRowBuilder().addComponents(alertButton);

        try {
            await interaction.deferReply();
            // console.log(`[${new Date().toISOString()}] Interaction deferred for /print command by ${interaction.user.tag} for ${printerKey}.`);

            // Using the robust getGcodeSettings
            const gcodeQuery = "total estimated time;default_filament_profile;filament used [g]";
            const extractedSettings = await getGcodeSettings(gcodeQuery, 90000, printerConfig);
            console.log(`[${new Date().toISOString()}] GCode settings received for ${printerKey}:`, extractedSettings);

            let replyContent;
            let imageAttachment = null;
            let imagePathForCleanup = null; // For the initial image
            let successfulMessagePackage = false;

            if (typeof extractedSettings === 'object' && extractedSettings !== null) {
                try {
                    // console.log(`[${new Date().toISOString()}] Attempting to capture initial frame from ${printerConfig.PRINTER_IP}...`);
                    const tempImageDir = path.join(__dirname, '..', '..', 'printer_images_temp'); // Ensure this dir exists or is creatable
                    imagePathForCleanup = await captureSingleFrameFromPrinter(
                        printerConfig.PRINTER_IP,
                        printerConfig.ACCESS_CODE,
                        { outputDir: tempImageDir, timeoutMs: 25000 } // Adjusted timeout
                    );
                    if (imagePathForCleanup) {
                        // console.log(`[${new Date().toISOString()}] SUCCESS: Initial image for ${printerKey} saved at ${imagePathForCleanup}`);
                        const uniqueAttachmentName = `${path.basename(imagePathForCleanup, '.jpg')}_initial_${Date.now()}.jpg`;
                        imageAttachment = new AttachmentBuilder(imagePathForCleanup, { name: uniqueAttachmentName });
                    }
                } catch (imageError) {
                    console.error(`[${new Date().toISOString()}] FAILURE: Could not capture initial image from ${printerConfig.PRINTER_IP}. Error: ${imageError.message}`);
                }

                // Use the more specific keys returned by the updated getGcodeSettings
                const fileName = extractedSettings["original_printer_filename"] || "N/A";
                const printerStatus = extractedSettings["printer_gcode_state"] || "N/A"; // This is the gcode_state
                const printTime = extractedSettings["total estimated time"] || "N/A"; // Assuming array, take first
                const filamentType = extractedSettings["default_filament_profile"] || "N/A";
                const filamentUsed = extractedSettings["filament used [g]"] || "N/A";

                replyContent = "```\n" +
                               `Printer: ${printerKey}\n` +
                               `File Name: ${fileName}\n` +
                               `Status: ${printerStatus}\n\n` +
                               `Est. Print Time: ${printTime}\n` +
                               `Filament Type: ${filamentType}\n` +
                               `Filament Used: ${filamentUsed}g\n` +    
                               "```";
                if (imageAttachment === null) {
                    replyContent += "\n(Could not retrieve printer camera image for initial display)";
                }
                successfulMessagePackage = true;

            } else { // Handles null or unexpected types from getGcodeSettings
                // console.warn(`[${new Date().toISOString()}] extractedSettings for ${printerKey} was null or not an object. Type: ${typeof extractedSettings}. This usually means no active/recent print or an issue fetching data.`);
                replyContent = `Could not retrieve detailed print job information for ${printerKey}. No active/recent print found, or an error occurred during data retrieval.`;
                successfulMessagePackage = false; // No button if we don't have initial data
            }
            
            if (replyContent.length > 1950) { // Leave some room for Discord's own formatting/limits
                console.warn(`[${new Date().toISOString()}] Reply content is too long for ${printerKey}. Length: ${replyContent.length}. Truncating.`);
                replyContent = replyContent.substring(0, 1950) + "... (message truncated)";
            }

            const messagePayload = { content: replyContent, ephemeral: false }; // Not ephemeral so button stays
            if (successfulMessagePackage) { // Only add button if initial data fetch was somewhat successful
                messagePayload.components = [row];
            }
            if (imageAttachment) {
                messagePayload.files = [imageAttachment];
            }

            const sentMessage = await interaction.editReply(messagePayload);
            // console.log(`[${new Date().toISOString()}] Reply sent successfully for ${printerKey}.`);

            // Cleanup initial image (optional, manage temp files as needed)
            // if (imagePathForCleanup && fs.existsSync(imagePathForCleanup)) {
                // fs.unlink(imagePathForCleanup, err => {
                // if (err) console.error(`[${new Date().toISOString()}] Error deleting temp image ${imagePathForCleanup}: ${err.message}`);
                // });
            // }

            if (!successfulMessagePackage) { // If we didn't add the button, no need for collector
                return;
            }

            const collectorInteractionId = interaction.id; // Use interaction ID as a key for the client map
            const filter = i => i.customId === alertButton.data.custom_id && i.user.id === interaction.user.id;
            const collector = sentMessage.createMessageComponentCollector({ componentType: ComponentType.Button, filter, time: 36_000_000 }); // 10 hours

            collector.on('collect', async buttonInteraction => {
                let bambuClientForAlert = activeAlertClients.get(collectorInteractionId);
                if (bambuClientForAlert && !bambuClientForAlert.closed) {
                     await buttonInteraction.reply({ content: `An alert is already active for ${printerKey} from this command.`, ephemeral: true });
                     return;
                }

                try {
                    await buttonInteraction.deferUpdate(); // Acknowledge button click

                    bambuClientForAlert = new BambuClient({
                        host: printerConfig.PRINTER_IP,
                        serialNumber: printerConfig.PRINTER_SERIAL,
                        accessToken: printerConfig.ACCESS_CODE,
                    });
                    activeAlertClients.set(collectorInteractionId, bambuClientForAlert);

                    // console.log(`[${new Date().toISOString()}] [Alert] User ${buttonInteraction.user.tag} activated status alert for ${printerKey}.`);
                    await buttonInteraction.followUp({ content: `✅ Alert armed for ${printerKey}! You'll be notified of status changes.`, ephemeral: true });

                    bambuClientForAlert.on("printer:statusUpdate", async (oldStatus, newStatus) => {
                        if (oldStatus === newStatus) return;

                        if (newStatus != "FAILED" && newStatus != "RUNNING" && newStatus != "PAUSE" && newStatus != "FINISH") return;

                        let alertImagePath = null;
                        let alertImageAttachment = null;
                        // console.log(`[${new Date().toISOString()}] [Alert] Status change for ${printerKey}: ${oldStatus} -> ${newStatus}.`);

                        try {
                            // console.log(`[${new Date().toISOString()}] [Alert] Capturing frame for ${printerKey} due to status change...`);
                            const tempImageDir = path.join(__dirname, '..', '..', 'printer_images_temp');
                            alertImagePath = await captureSingleFrameFromPrinter(
                                printerConfig.PRINTER_IP,
                                printerConfig.ACCESS_CODE,
                                { outputDir: tempImageDir, timeoutMs: 15000 }
                            );
                            if (alertImagePath) {
                                const uniqueName = `${path.basename(alertImagePath, '.jpg')}_alert_${Date.now()}.jpg`;
                                alertImageAttachment = new AttachmentBuilder(alertImagePath, { name: uniqueName });
                            }
                        } catch (imgError) {
                            console.error(`[${new Date().toISOString()}] [Alert] Failed to capture image for ${printerKey} during status update: ${imgError.message}`);
                        }
                            
                        try {
                            const cancelButton = new ButtonBuilder()
                                .setCustomId(`cancel_button${printerKey}`) // More unique customId
                                .setLabel("Cancel Alert")
                                .setStyle(ButtonStyle.Danger);

                            const alertRow = ActionRowBuilder().addComponents(cancelButton)

                            const alertMsgPayload = { 
                                content: `🚨 ${printerKey} status changed: **${newStatus}** 🚨\nTag: <@${buttonInteraction.user.id}>`, 
                                ephemeral: true, // Keep ephemeral or send to channel? User choice.
                                components: [alertRow]
                            };
                            if (alertImageAttachment) {
                                alertMsgPayload.files = [alertImageAttachment];
                            }
                            await buttonInteraction.followUp(alertMsgPayload);
                        } catch (followUpErr) {
                            console.error(`[${new Date().toISOString()}] [Alert] Failed to send followUp for ${printerKey} status change: ${followUpErr.message}`);
                        }
                        // Optional: cleanup alertImagePath if not handled by captureSingleFrameFromPrinter
                    });

                    bambuClientForAlert.on('error', (err) => {
                        console.error(`[${new Date().toISOString()}] [Alert] BambuClient MQTT error for ${printerKey} (IID: ${collectorInteractionId}): ${err.message || err}`);
                        buttonInteraction.followUp({ content: `⚠️ MQTT error for ${printerKey} alerts. Alerting may stop.`, ephemeral: true }).catch(e => {});
                        if (activeAlertClients.has(collectorInteractionId)) {
                            activeAlertClients.get(collectorInteractionId)?.disconnect();
                            activeAlertClients.delete(collectorInteractionId);
                        }
                    });
                    
                    bambuClientForAlert.on('closed', () => {
                        // console.log(`[${new Date().toISOString()}] [Alert] BambuClient MQTT connection closed for ${printerKey} (IID: ${collectorInteractionId}).`);
                        // No action needed here, collector end or error handler will manage cleanup.
                    });

                    await bambuClientForAlert.connect();
                    // console.log(`[${new Date().toISOString()}] [Alert] BambuClient connected for ${printerKey} status alerts (IID: ${collectorInteractionId}).`);

                } catch (collectErr) {
                    console.error(`[${new Date().toISOString()}] Error in button collector setup for ${printerKey}:`, collectErr);
                    if (!buttonInteraction.replied && !buttonInteraction.deferred) {
                        await buttonInteraction.reply({ content: 'Could not set up printer alerts due to an internal error.', ephemeral: true }).catch(e => {});
                    } else {
                        await buttonInteraction.followUp({ content: 'Could not set up printer alerts due to an internal error.', ephemeral: true }).catch(e => {});
                    }
                    // Ensure client is cleaned up if connect failed or error before listeners fully set
                    const client = activeAlertClients.get(collectorInteractionId);
                    if (client) {
                        client.disconnect();
                        activeAlertClients.delete(collectorInteractionId);
                    }
                }
            });

            collector.on('end', collected => {
                // console.log(`[${new Date().toISOString()}] Button collector ended for ${printerKey} (IID: ${collectorInteractionId}). Collected ${collected.size} items.`);
                const clientToDisconnect = activeAlertClients.get(collectorInteractionId);
                if (clientToDisconnect) {
                    // console.log(`[${new Date().toISOString()}] [Alert] Disconnecting BambuClient for ${printerKey} as collector ended (IID: ${collectorInteractionId}).`);
                    clientToDisconnect.disconnect();
                    activeAlertClients.delete(collectorInteractionId);
                }
                // Optionally, edit the original message to remove or disable the button
                const disabledButton = ButtonBuilder.from(alertButton).setDisabled(true).setLabel("🔔 Alerts Expired");
                const expiredRow = new ActionRowBuilder().addComponents(disabledButton);
                sentMessage.edit({ components: [expiredRow] }).catch(e => { /* console.error("Error editing message on collector end:", e.message) */ });
            });

        } catch (error) {
            console.error(`[${new Date().toISOString()}] CRITICAL Error executing /print command for ${printerKey} by ${interaction.user.tag}:`, error);
            const errorMessage = 'An unexpected error occurred while processing your request for print settings. Please try again later.';
            if (interaction.deferred || interaction.replied) {
                 try {
                    await interaction.editReply({ content: errorMessage, components: [], files: [] });
                 } catch (editError) {
                    console.error(`[${new Date().toISOString()}] Failed to edit reply with critical error message:`, editError);
                 }
            } else {
                try {
                    await interaction.reply({ content: errorMessage, ephemeral: true, components: [], files: [] });
                } catch (replyError) {
                    console.error(`[${new Date().toISOString()}] Failed to send initial reply with critical error message:`, replyError);
                }
            }
        }
    },
};