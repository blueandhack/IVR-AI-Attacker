import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";

import twilio from "twilio";
import fs from "fs";
import path from "path";
import { parse as csvParse } from "csv-parse/sync";

// Load environment variables from .env file
dotenv.config();

// Retrieve the OpenAI API key from environment variables.
const { OPENAI_API_KEY } = process.env;

const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER } =
  process.env;

let twilioClient = null;
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
  twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
}

if (!OPENAI_API_KEY) {
  console.error("Missing OpenAI API key. Please set it in the .env file.");
  process.exit(1);
}

// Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Constants
const SYSTEM_MESSAGE =
  "You are a helpful and bubbly AI assistant who loves to chat about anything the user is interested about and is prepared to offer them facts. You have a penchant for dad jokes, owl jokes, and rickrolling – subtly. Always stay positive, but work in a joke when appropriate.";
const VOICE = "alloy";
const PORT = process.env.PORT || 5050; // Allow dynamic port assignment

// List of Event Types to log to the console. See the OpenAI Realtime API Documentation: https://platform.openai.com/docs/api-reference/realtime
const LOG_EVENT_TYPES = [
  "error",
  "response.content.done",
  "rate_limits.updated",
  "response.done",
  "input_audio_buffer.committed",
  "input_audio_buffer.speech_stopped",
  "input_audio_buffer.speech_started",
  "session.created",
];

// Show AI response elapsed timing calculations
const SHOW_TIMING_MATH = false;

// Root Route
fastify.get("/", async (request, reply) => {
  reply.send({ message: "Twilio Media Stream Server is running!" });
});

// Route for Twilio to handle incoming calls
// Accepts query params for bankNumber, ssnLast4, accountLast4, zipcode
fastify.all("/incoming-call", async (request, reply) => {
  // Get verification info from query params
  const { ssnLast4, accountLast4, zipcode } = request.query;

  // Compose a system message for the AI to speak first and answer IVR
  let aiInstructions = SYSTEM_MESSAGE;
  if (ssnLast4 && accountLast4 && zipcode) {
    aiInstructions += `\n\nYou are calling a bank's customer service IVR. When the call starts, do not say anything. Wait for the IVR or agent to greet you and prompt you. When prompted, say: 'What is my balance?'. Then, when asked, provide the following information in a clear, natural voice:\n- Last 4 digits of SSN: ${ssnLast4}\n- Last 4 digits of account: ${accountLast4}\n- Zip code: ${zipcode}.\nWait for each prompt before answering. Do not provide extra information.`;
  }

  // Build the Stream URL and escape & as &amp; for XML
  let streamUrl = `wss://${request.headers.host}/media-stream`;

  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                          <Response>
                              <Pause length="1"/>
                              <Connect>
                                  <Stream url="${streamUrl}" />
                              </Connect>
                          </Response>`;

  reply.type("text/xml").send(twimlResponse);
});

// API to trigger an outbound call to a bank's customer service and connect to OpenAI live mode
// Accepts: bankNumber, ssnLast4, accountLast4, zipcode
fastify.post("/call-me", async (request, reply) => {
  if (!twilioClient) {
    return reply.status(500).send({ error: "Twilio is not configured." });
  }

  const { bankNumber } = request.body;

  // Pass verification info as query params to /incoming-call
  const twimlUrl = `https://${request.headers.host}/incoming-call`;

  try {
    const call = await twilioClient.calls.create({
      to: bankNumber,
      from: TWILIO_PHONE_NUMBER,
      url: twimlUrl,
    });
    reply.send({ message: "Call initiated", sid: call.sid });
  } catch (err) {
    console.error("Error initiating call:", err);
    reply.status(500).send({ error: "Failed to initiate call." });
  }
});

// WebSocket route for media-stream
fastify.register(async (fastify) => {
  fastify.get("/media-stream", { websocket: true }, (connection, req) => {
    console.log("Client connected");

    // Connection-specific state
    let streamSid = null;
    let latestMediaTimestamp = 0;
    let lastAssistantItem = null;
    let markQueue = [];
    let responseStartTimestampTwilio = null;

    // Read data.csv from local directory
    const csvPath = path.join(process.cwd(), "data.csv");

    console.log("Reading data from:", csvPath);

    let records;
    try {
      const csvContent = fs.readFileSync(csvPath, "utf8");
      records = csvParse(csvContent, { columns: true });
    } catch (err) {
      console.error("Failed to read data.csv:", err);
      return reply.status(500).send({ error: "Failed to read data.csv" });
    }

    if (!records || records.length === 0) {
      console.error("No data found in data.csv");
      return reply.status(400).send({ error: "No data found in data.csv" });
    }

    console.log("Data loaded from data.csv:", records);

    // Use the first row of the CSV
    const { ssnLast4, accountLast4, zipcode } = records[0];
    if (!ssnLast4 || !accountLast4 || !zipcode) {
      return reply.status(400).send({
        error:
          "Missing required fields in data.csv: bankNumber, ssnLast4, accountLast4, zipcode.",
      });
    }

    console.log("last ssn is ", ssnLast4);
    console.log("last account is ", accountLast4);
    console.log("last zipcode is ", zipcode);

    // Compose a system message for the AI to speak first and answer IVR
    let aiInstructions = SYSTEM_MESSAGE;
    if (ssnLast4 && accountLast4 && zipcode) {
      aiInstructions += `\n\nYou are calling a bank's customer service IVR. When the call starts, say: 'What is my balance?'. When prompted, provide the following information in a clear, natural voice:\n- Last 4 digits of SSN: ${ssnLast4}\n- Last 4 digits of account: ${accountLast4}\n- Zip code: ${zipcode}.\nWait for each prompt before answering. Do not provide extra information.`;
    }

    const openAiWs = new WebSocket(
      "wss://api.openai.com/v1/realtime?model=gpt-4o-mini-realtime-preview-2024-12-17",
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "realtime=v1",
        },
      }
    );

    // Control initial session with OpenAI
    const initializeSession = () => {
      const sessionUpdate = {
        type: "session.update",
        session: {
          turn_detection: { type: "server_vad" },
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          voice: VOICE,
          instructions: aiInstructions,
          modalities: ["text", "audio"],
          temperature: 0.8,
        },
      };

      console.log("Sending session update:", JSON.stringify(sessionUpdate));
      openAiWs.send(JSON.stringify(sessionUpdate));

      // Do NOT have AI speak first; wait for IVR prompt
    };

    // Send initial conversation item if AI talks first
    // No initial conversation item; AI will wait for IVR prompt before speaking

    // Handle interruption when the caller's speech starts
    const handleSpeechStartedEvent = () => {
      if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
        const elapsedTime = latestMediaTimestamp - responseStartTimestampTwilio;
        if (SHOW_TIMING_MATH)
          console.log(
            `Calculating elapsed time for truncation: ${latestMediaTimestamp} - ${responseStartTimestampTwilio} = ${elapsedTime}ms`
          );

        if (lastAssistantItem) {
          const truncateEvent = {
            type: "conversation.item.truncate",
            item_id: lastAssistantItem,
            content_index: 0,
            audio_end_ms: elapsedTime,
          };
          if (SHOW_TIMING_MATH)
            console.log(
              "Sending truncation event:",
              JSON.stringify(truncateEvent)
            );
          openAiWs.send(JSON.stringify(truncateEvent));
        }

        connection.send(
          JSON.stringify({
            event: "clear",
            streamSid: streamSid,
          })
        );

        // Reset
        markQueue = [];
        lastAssistantItem = null;
        responseStartTimestampTwilio = null;
      }
    };

    // Send mark messages to Media Streams so we know if and when AI response playback is finished
    const sendMark = (connection, streamSid) => {
      if (streamSid) {
        const markEvent = {
          event: "mark",
          streamSid: streamSid,
          mark: { name: "responsePart" },
        };
        connection.send(JSON.stringify(markEvent));
        markQueue.push("responsePart");
      }
    };

    // Open event for OpenAI WebSocket
    openAiWs.on("open", () => {
      console.log("Connected to the OpenAI Realtime API");
      setTimeout(initializeSession, 100);
    });

    // Listen for messages from the OpenAI WebSocket (and send to Twilio if necessary)
    openAiWs.on("message", (data) => {
      try {
        const response = JSON.parse(data);

        if (LOG_EVENT_TYPES.includes(response.type)) {
          console.log(`Received event: ${response.type}`, response);
        }

        // If the IVR prompt includes 'transfer', 'account manager', or 'manager', hang up and disconnect
        if (
          (response.type === "response.content.done" ||
            response.type === "response.done" ||
            response.type === "response.content") &&
          response.content &&
          typeof response.content === "string"
        ) {
          const contentLower = response.content.toLowerCase();
          if (
            contentLower.includes("transfer") ||
            contentLower.includes("account manager") ||
            contentLower.includes("manager")
          ) {
            console.log(
              "IVR prompt includes 'transfer', 'account manager', or 'manager'. Hanging up and disconnecting AI."
            );
            if (connection) connection.close();
            if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
            return;
          }
        }

        if (response.type === "response.audio.delta" && response.delta) {
          const audioDelta = {
            event: "media",
            streamSid: streamSid,
            media: { payload: response.delta },
          };
          connection.send(JSON.stringify(audioDelta));

          // First delta from a new response starts the elapsed time counter
          if (!responseStartTimestampTwilio) {
            responseStartTimestampTwilio = latestMediaTimestamp;
            if (SHOW_TIMING_MATH)
              console.log(
                `Setting start timestamp for new response: ${responseStartTimestampTwilio}ms`
              );
          }

          if (response.item_id) {
            lastAssistantItem = response.item_id;
          }

          sendMark(connection, streamSid);
        }

        if (response.type === "input_audio_buffer.speech_started") {
          handleSpeechStartedEvent();
        }
      } catch (error) {
        console.error(
          "Error processing OpenAI message:",
          error,
          "Raw message:",
          data
        );
      }
    });

    // Handle incoming messages from Twilio
    connection.on("message", (message) => {
      try {
        const data = JSON.parse(message);

        switch (data.event) {
          case "media":
            latestMediaTimestamp = data.media.timestamp;
            if (SHOW_TIMING_MATH)
              console.log(
                `Received media message with timestamp: ${latestMediaTimestamp}ms`
              );
            if (openAiWs.readyState === WebSocket.OPEN) {
              const audioAppend = {
                type: "input_audio_buffer.append",
                audio: data.media.payload,
              };
              openAiWs.send(JSON.stringify(audioAppend));
            }
            break;
          case "start":
            streamSid = data.start.streamSid;
            console.log("Incoming stream has started", streamSid);

            // Reset start and media timestamp on a new stream
            responseStartTimestampTwilio = null;
            latestMediaTimestamp = 0;
            break;
          case "mark":
            if (markQueue.length > 0) {
              markQueue.shift();
            }
            break;
          default:
            console.log("Received non-media event:", data.event);
            break;
        }
      } catch (error) {
        console.error("Error parsing message:", error, "Message:", message);
      }
    });

    // Handle connection close
    connection.on("close", () => {
      if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
      console.log("Client disconnected.");
    });

    // Handle WebSocket close and errors
    openAiWs.on("close", () => {
      console.log("Disconnected from the OpenAI Realtime API");
    });

    openAiWs.on("error", (error) => {
      console.error("Error in the OpenAI WebSocket:", error);
    });
  });
});

fastify.listen({ port: PORT }, (err) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`Server is listening on port ${PORT}`);
});
