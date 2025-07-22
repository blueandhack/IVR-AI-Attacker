# IVR-AI-Attacker

A Node.js Fastify server that connects Twilio phone calls to OpenAI's Realtime API, enabling an AI assistant to interact with bank IVR systems and answer verification prompts using data from a local CSV file.

## Features

- Outbound call initiation to a bank's customer service number using Twilio
- AI assistant powered by OpenAI Realtime API (gpt-4o-realtime-preview)
- Reads verification info (SSN, account, zipcode) from `data.csv`
- AI waits for IVR prompts and responds with balance inquiry and verification info
- WebSocket media streaming between Twilio and OpenAI
- Easy development with `nodemon` auto-reload

## Prerequisites

- Node.js 18+
- Twilio account (with phone number, SID, and Auth Token)
- OpenAI API key

## Setup

1. **Clone the repository**

   ```sh
   git clone https://github.com/blueandhack/IVR-AI-Attacker.git
   cd IVR-AI-Attacker
   ```

2. **Install dependencies**

   ```sh
   npm install
   ```

3. **Configure environment variables**

   Create a `.env` file in the project root:

   ```env
   OPENAI_API_KEY=your_openai_api_key
   TWILIO_ACCOUNT_SID=your_twilio_sid
   TWILIO_AUTH_TOKEN=your_twilio_auth_token
   TWILIO_PHONE_NUMBER=your_twilio_phone_number
   ```

4. **Prepare your data.csv**

   The file should have a header and at least one row:

   ```csv
   ssnLast4,accountLast4,zipcode
   1234,5678,90210
   ```

## Usage


### Start the server

- For production:
  ```sh
  npm start
  ```
- For development (auto-reload):
  ```sh
  npm run dev
  ```

### Expose your server to the internet (ngrok)

Twilio webhooks require a public URL. Use [ngrok](https://ngrok.com/) to tunnel your local server:

1. Install ngrok if you haven't:
   ```sh
   npm install -g ngrok
   ```
2. Start ngrok on your server port (default 5050):
   ```sh
   ngrok http 5050
   ```

3. Use the HTTPS forwarding URL from ngrok (e.g., `https://your-ngrok-id.ngrok-free.app`) as your webhook base for Twilio.

### Configure Twilio Voice Webhook

1. Go to your [Twilio Console Phone Numbers](https://www.twilio.com/console/phone-numbers/incoming).
2. Click your Twilio phone number.
3. Under "Voice & Fax" > "A CALL COMES IN", set the webhook to:
   ```
   https://your-ngrok-id.ngrok-free.app/incoming-call
   ```
   and set the method to `HTTP POST`.
4. Save your changes.


### Make a call

Send a POST request to `/call-me` with the bank's customer service number in the JSON body:

```sh
curl -X POST https://your-ngrok-id.ngrok-free.app/call-me \
  -H "Content-Type: application/json" \
  -d '{"bankNumber": "+18001234567"}'
```

- The server will use the provided `bankNumber` and read the first row from `data.csv` for verification info.
- The AI will wait for the IVR greeting, then ask for the balance and provide verification info as prompted.

## How it works

- `/call-me`: Reads `data.csv` and starts a Twilio call to the bank's number.
- `/incoming-call`: Twilio webhook that sets up the media stream and passes verification info.
- `/media-stream`: WebSocket endpoint that streams audio between Twilio and OpenAI, and injects the verification info for the AI to use.

## Customization

- Edit `data.csv` to change the target bank number or verification info.
- Update the system prompt in `index.js` to change the AI's personality or instructions.


## Disclaimer

This project is provided for educational and research purposes only. The author does not condone or encourage any illegal, unethical, or unauthorized use of this software. You are solely responsible for complying with all applicable laws, regulations, and terms of service. Use at your own risk.

## License

GPLv3

---

**Author:** Yujia Lin

For issues, see [GitHub Issues](https://github.com/blueandhack/IVR-AI-Attacker/issues)
