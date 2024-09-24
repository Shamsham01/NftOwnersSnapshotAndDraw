# MultiversX ESDT Transfer Automation
This project provides an API to automate ESDT (Elrond Standard Digital Token) transfers on the MultiversX blockchain, enabling users to send tokens seamlessly via a secure, token-based authentication system. The API can be integrated with Make.com or any other automation platform to streamline token transfers without complex setup or third-party SaaS costs. Hosted on Render.com, the service is highly cost-effective and easy to deploy.

## Features
- Secure and authenticated API to initiate ESDT transfers.
- Seamless integration with Make.com for automated token transfers.
- Supports ESDT token transfers on MultiversX blockchain.
- Built with Express.js and @multiversx/sdk to handle blockchain interactions.
- Deployed on Render.com for affordability and scalability.
## Prerequisites
- Render Account: A Render.com account to host the API.
- MultiversX Wallet: A PEM file for signing transactions.
- Make.com Account: To automate the transaction processes.
## Deployment
1. Clone the Repository
2. Fork or clone this GitHub repository.
Head to Render.com and create a new Web Service using the repository.
3. Render Setup:
- Navigate to Render's dashboard and click on "New Web Service."
- Paste the repository URL and configure the service.
- Set up the following environment variables:
- SECURE_TOKEN: A secure token for API authentication (minimum of 24 characters).
- PEM_PATH: The path to your PEM file (e.g., /etc/secrets/walletKey.pem).
- PORT: (Optional) Specify a custom port or leave as default.
3. Deploy the Service
Deploy the web service and wait for it to be live. The server will automatically start and listen for incoming requests.
## API Usage
The API exposes a POST endpoint to initiate ESDT token transfers. You can use Postman or Make.com to trigger this process.

### POST /execute
### Request Headers
### Authorization: Bearer token using the value of SECURE_TOKEN.
### Request Body (JSON)
```jsx
{
  "recipient": "erd1xxxxxx",
  "amount": "100",
  "tokenTicker": "REWARD"
}
```
- recipient: The address of the recipient wallet (in Bech32 format).
- amount: The number of tokens to transfer (automatic decimal handling is supported).
- tokenTicker: The ticker of the ESDT token (e.g., REWARD, UTK).

### Example API Request (Postman)
- Open Postman.
- Create a new POST request.
- Set the URL to your Render API endpoint with /execute appended, e.g., https://your-api-url.onrender.com/execute.
- Go to the "Authorization" tab:
- Select "Bearer Token" and provide your SECURE_TOKEN.
- Set the request body to raw, and content type to application/json. Use the following JSON format:
```jsx
{
  "recipient": "erd1exampleaddress123",
  "amount": "10",
  "tokenTicker": "REWARD"
}
```
### Send the request, and you will receive a transaction hash as the response if the transaction is successful.

## Automating with Make.com
- Create a new scenario in Make.com.
- Use the HTTP module to send a POST request to your deployed API with the required payload.
- Use the webhook response to automate subsequent steps, such as notifying users about successful transfers.

## Token Decimal Handling
- The API simplifies the token transfer process by automatically converting the human-readable amount into the correct format based on token decimals. For example:

- If the token has 8 decimals, sending 100 tokens will internally convert to 10000000000.
This is handled dynamically based on the token's configuration fetched from the MultiversX network.

### Contributing
Feel free to fork the project and submit pull requests if you'd like to improve or add new features.

License
This project is licensed under the ISC License.
