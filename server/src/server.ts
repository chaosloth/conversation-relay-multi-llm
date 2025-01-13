import "dotenv/config";
import colors from "colors";
import express from "express";
import expressWs from "express-ws";

import { AssistantService } from "./services/assistant-service";

import { ToolContext, ToolsService } from "./services/tools-service";

import {
  ILargeLanguageModelService,
  createLLMProvider,
} from "./services/llm-service";

import { SilenceHandler } from "./services/SilenceHandler";
import { ChatCompletionMessageToolCall } from "openai/resources/chat/completions";

const serverDomain =
  process.env.HOSTNAME ||
  process.env.SERVER_FLY ||
  process.env.CRELAY_SERVER_DOMAIN ||
  "localhost";

const expressServer = express(); // Type = Express
const wsServer = expressWs(expressServer); // Type = expressWs.Instance
const app = wsServer.app; // type = wsExpress.Application

const PORT = process.env.PORT || 3000;
const SILENCE_SECONDS_THRESHOLD = 5; // The maximum time in seconds that the server will wait for user input from Twilio before sending a reminder message
const SILENCE_RETRY_THRESHOLD = 3; // The maximum number of times the server will request user input

const assistantService = new AssistantService();

/*********************
 *
 *  Web to get all definitions
 *
 *********************/
app.get("/assistants", (req, res) => {
  console.log(`Fetching configured assistants`);

  assistantService
    .getAssistants()
    .then((assistants) => {
      res.json(assistants);
    })
    .finally(() => res.end());
});

/*********************
 *
 *  Web endpoint to a single assistant by name
 *
 *********************/
app.get("/assistant", (req, res) => {
  const target_name = req.query.name?.toString();
  if (target_name === undefined || target_name === "") {
    res.status(404);
    res.json({ message: "Assistant not found" });
    res.end();
    return;
  }

  console.log(`Fetching configured assistant ${target_name}`);

  assistantService
    .getAssistant(target_name)
    .then((assistant) => {
      if (!assistant) {
        res.status(404);
        res.json({ message: "Assistant not found" });
        res.end();
        return;
      }
      res.json(assistant);
    })
    .finally(() => res.end());
});

/*********************
 *
 *  Web endpoint to get starting TwiML
 *
 *********************/
app.post("/twiml", async (req, res) => {
  console.log(`Incoming request url`, req.url);

  // Get assistants from cache
  assistantService.getAssistants().then((assistants) => {
    console.log(`Fetched ${assistants?.length} assistants`);
  });

  // Get requested assistant
  let assistant = await assistantService.getAssistant(
    req.query.assistant?.toString() || ""
  );

  /*********************
   *
   *  Direct the call to our assistant
   *
   *********************/
  let xml = `
  <Response>
    <Connect>
      <ConversationRelay url="wss://${process.env.CRELAY_SERVER_DOMAIN}/conversation-relay">
        <Language code="${assistant?.language_code}" ttsProvider="${assistant?.tts_provider}" voice="${assistant?.tts_voice}" />
        <Parameter name="assistant" value ="${assistant?.assistant_name}"/>
      </ConversationRelay>
    </Connect>
  </Response>
  `;

  console.log(`Response TwiML`, xml);

  res.status(200);
  res.type("text/xml");
  res.end(xml);
});

/*********************
 *
 *  Websocket endpoint
 *
 *********************/
app.ws("/conversation-relay", (ws, req) => {
  console.log("New Conversation Relay websocket established");
  let llmService: ILargeLanguageModelService | undefined = undefined;
  let toolService: ToolsService | undefined = undefined;
  let silenceHandler: SilenceHandler | undefined = undefined;
  let interactionCount = 0;

  // Handle incoming messages
  ws.on("message", async (data) => {
    try {
      const message = JSON.parse(data.toString());
      console.log(
        `[Conversation Relay] Message received: ${JSON.stringify(
          message,
          null,
          4
        )}`
      );

      // Reset silence timer based on message type if handler exists
      if (silenceHandler) {
        silenceHandler.resetTimer(message.type);
      }

      switch (message.type) {
        case "setup":
          /**
                     * Handle setup message. Just logging sessionId out for now.
                     * This is the object received from Twilio:
                     * {
                            "type": "setup",
                            "sessionId": "VXxxxx",
                            "callSid": "CAxxxx",
                            "parentCallSid": "",
                            "from": "+614nnnn",
                            "to": "+612nnnn",
                            "forwardedFrom": "+612nnnnn",
                            "callerName": "",
                            "direction": "inbound",
                            "callType": "PSTN",
                            "callStatus": "RINGING",
                            "accountSid": "ACxxxxxx",
                            "applicationSid": null
                        }
                     */
          // console.debug(`[Conversation Relay] Setup message received: ${JSON.stringify(message, null, 4)}`);
          // Log out the to and from phone numbers
          console.log(
            `4) [Conversation Relay] SETUP. Call from: ${message.from} to: ${message.to} with call SID: ${message.callSid}`
          );

          /*********************
           *
           *  Get assistants for call
           *
           *********************/
          const assistant = await assistantService.getAssistant(
            message.customParameters?.assistant
          );
          console.log("Assistant definition", assistant);

          if (!assistant) {
            console.error("Error fetching assistant");
            return;
          }

          /*********************
           *
           *  Start helpers
           *
           *********************/
          llmService = createLLMProvider(message.callSid, assistant);
          toolService = new ToolsService(assistant);

          if (llmService === undefined) {
            console.error(`Error. LLM Service is undefined`.bgRed);
            return;
          }

          /*********************
           *
           *  Wiring up handlers - LLM
           *
           *********************/
          llmService.on("llm.stream", async (data, icount) => {
            console.log(
              `Interaction ${icount}: ${data.call_sid} LLM (llm.stream) -> CRelay: ${data.llmReply.partialResponse}`
                .green
            );

            let llmResponse = {
              type: "text",
              token: data.llmReply.partialResponse,
              last: false,
            };
            ws.send(JSON.stringify(llmResponse));
          });

          llmService.on("llm.complete", async (data, icount) => {
            console.log(
              `Interaction ${icount}: ${data.call_sid} LLM (llm.complete) -> CRelay end of speech`
                .green
            );

            let llmResponse = {
              type: "text",
              token: "",
              last: true,
            };
            ws.send(JSON.stringify(llmResponse));
          });

          llmService.on("tool.request", async (context, tool) => {
            console.log(`Tool request`, tool);
            toolService?.runTool(context, tool);
          });

          /*********************
           *
           *  Wiring up handlers - Tools
           *
           *********************/
          toolService.on(
            "tool.result",
            (
              context: ToolContext,
              tool: ChatCompletionMessageToolCall,
              result
            ) => {
              console.log(`Tool execution result`, result);
              llmService?.completion(result, 1, "tool", undefined, tool.id);
            }
          );

          /*********************
           *
           *  Send first message
           *
           *********************/
          llmService.addContext(
            `The users phone number is ${message.from}`,
            "system"
          );

          llmService.addContext(assistant?.initial_message, "system");
          let initialMessage = {
            type: "text",
            token: assistant.initial_message,
            last: true,
          };
          ws.send(JSON.stringify(initialMessage));

          // Initialize and start silence monitoring after setup is complete
          silenceHandler = new SilenceHandler(
            SILENCE_SECONDS_THRESHOLD,
            SILENCE_RETRY_THRESHOLD
          );
          silenceHandler.startMonitoring(
            (silenceMessage: { type: string; message: string }) => {
              console.log(
                `[Conversation Relay] Sending silence breaker message: ${JSON.stringify(
                  silenceMessage
                )}`
              );
              ws.send(JSON.stringify(silenceMessage));
            }
          );
          break;

        case "info":
          /*********************
           *
           *  Handle info messages
           *
           *********************/
          console.debug(
            `[Conversation Relay] INFO: ${JSON.stringify(message, null, 4)}`
          );
          break;

        case "prompt":
          /*********************
           *
           *  Handle incoming messages
           *
           *********************/
          console.info(
            `[Conversation Relay:] PROMPT >>>>>>: ${message.voicePrompt}`
          );

          if (llmService === undefined) {
            console.error(`Error. LLM Service is undefined`.bgRed);
            return;
          }

          llmService.completion(message.voicePrompt, interactionCount, "user");
          interactionCount += 1;
          break;

        case "interrupt":
          /*********************
           *
           *  Handle interrupt messages
           *
           *********************/

          //!!
          //!! TODO: Handle interruptions
          //!!
          console.info(
            `[Conversation Relay] INTERRUPT ...... : ${message.utteranceUntilInterrupt}`
          );
          break;

        case "dtmf":
          /*********************
           *
           *  Handle DTMF messages
           *
           *********************/

          //!!
          //!! TODO: Handle DTMF
          //!!
          // We are just logging them out for now.
          console.debug(`[Conversation Relay] DTMF: ${message.digit}`);
          break;

        default:
          console.log(
            `[Conversation Relay] Unknown message type: ${message.type}`
          );
      }
    } catch (error) {
      console.error("[Conversation Relay] Error in message handling:", error);
    }
  });

  // Handle client disconnection
  ws.on("close", () => {
    console.log("Client disconnected");

    /*********************
     *
     *  Stop Event
     *
     *********************/
    // Clean up the silence handler if it exists
    if (silenceHandler) {
      silenceHandler.cleanup();
    }

    console.log(`Twilio -> WS ended.`.red);

    if (llmService) llmService.destroy();
    if (toolService) toolService.destroy();

    llmService = undefined;
    toolService = undefined;
  });

  // Handle errors
  ws.on("error", (error) => {
    console.error("WebSocket error:", error);
  });
});

////////// SERVER BASICS //////////

// Basic HTTP endpoint
app.get("/", (req, res) => {
  res.send("WebSocket Server Running");
});

// Start the server
const server = app
  .listen(PORT, () => {
    console.log(
      colors.bgMagenta(
        `
                                
      APPLICATION STARTING...   
                                `
      )
    );

    console.log(`Server is running on port[${PORT}]`);
    console.log(`Server has been configured with domain [${serverDomain}]`);

    assistantService.getAssistants().then((assistants) => {
      console.log(`Fetched ${assistants?.length} assistants`);
    });
    console.log(
      colors.bgGreen(
        `
                                
      APPLICATION READY         
                                `
      )
    );
  })
  .on("error", (error) => {
    console.error("Failed to start server:", error);
    process.exit(1);
  });
