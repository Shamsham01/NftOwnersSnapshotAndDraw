import { 
    Address, 
    TransactionsFactoryConfig, 
    TransferTransactionsFactory, 
    TokenTransfer, 
    Token, 
    Transaction, 
    TransactionPayload
} from '@multiversx/sdk-core';

import fetch from 'node-fetch';
import ora from 'ora';
import pThrottle from 'p-throttle';
import express from 'express';
import bodyParser from 'body-parser';
import { ProxyNetworkProvider } from '@multiversx/sdk-network-providers';
import { UserSigner } from '@multiversx/sdk-wallet';
import { format as formatCsv } from 'fast-csv';
import { Readable } from 'stream';
import BigNumber from 'bignumber.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10000;
const SECURE_TOKEN = process.env.SECURE_TOKEN;  // Secure Token for authorization
const TREASURY_WALLET = "erd158k2c3aserjmwnyxzpln24xukl2fsvlk9x46xae4dxl5xds79g6sdz37qn"; // Treasury wallet
const provider = new ProxyNetworkProvider("https://gateway.multiversx.com", { clientName: "javascript-api" });
const FIXED_USD_FEE = 0.03; // Fixed fee in USD
const REWARD_TOKEN = "REWARD-cf6eac";

const whitelistFilePath = path.join(__dirname, 'whitelist.json');


app.use(bodyParser.json());  // Support JSON-encoded bodies

// Middleware to check authorization token for protected routes
const checkToken = (req, res, next) => {
    const token = req.headers.authorization;
    if (token === `Bearer ${SECURE_TOKEN}`) {
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized' });
    }
};

// New Authorization Endpoint for Make.com to verify connection
app.post('/authorization', (req, res) => {
    try {
        const token = req.headers.authorization;
        if (token === `Bearer ${SECURE_TOKEN}`) {
            res.json({ message: "Authorization successful" });
        } else {
            res.status(401).json({ error: "Unauthorized" });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Helper function to fetch token decimals
const getTokenDecimals = async (tokenTicker) => {
    const apiUrl = `https://api.multiversx.com/tokens/${tokenTicker}`;
    const response = await fetch(apiUrl);
    if (!response.ok) {
        throw new Error(`Failed to fetch token info: ${response.statusText}`);
    }
    const tokenInfo = await response.json();
    return tokenInfo.decimals || 0;
};

const convertAmountToBlockchainValue = (amount, decimals) => {
    const factor = new BigNumber(10).pow(decimals);
    return new BigNumber(amount).multipliedBy(factor).toFixed(0);
};

const checkTransactionStatus = async (txHash, retries = 40, delay = 5000) => {
    const txStatusUrl = `https://api.multiversx.com/transactions/${txHash}`;

    for (let i = 0; i < retries; i++) {
        try {
            const response = await fetch(txStatusUrl);

            // If transaction is not yet visible (404), that's normal for new transactions
            // Just wait and retry rather than throwing an error
            if (response.status === 404) {
                console.log(`Transaction ${txHash} not found yet (normal for new tx), retrying in ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
                continue;
            }

            if (!response.ok) {
                console.warn(`Non-200 response for ${txHash}: ${response.status}`);
                // Don't throw an error, just continue retrying
                await new Promise(resolve => setTimeout(resolve, delay));
                continue;
            }

            const txStatus = await response.json();

            if (txStatus.status === "success") {
                return { status: "success", txHash };
            } else if (txStatus.status === "fail") {
                return { status: "fail", txHash };
            }

            console.log(`Transaction ${txHash} still pending, retrying...`);
        } catch (error) {
            console.error(`Error fetching transaction ${txHash}: ${error.message}`);
            // Don't throw here, just continue with the retry loop
        }

        await new Promise(resolve => setTimeout(resolve, delay));
    }

    // After all retries, we still don't have a definitive status
    return { status: "unknown", txHash };
};

// Helper function to generate CSV data as a string
const generateCsv = async (data) => {
    const csvData = [];
    data.forEach((row) => {
        csvData.push({
            address: row.address || row.owner,
            identifier: row.identifier || '',
            balance: row.balance || '',
            metadataFileName: row.metadataFileName || '',
            attributes: row.attributes ? JSON.stringify(row.attributes) : ''
        });
    });

    return new Promise((resolve, reject) => {
        const csvStream = formatCsv({ headers: true });
        const chunks = [];

        csvStream.on('data', (chunk) => chunks.push(chunk.toString()));
        csvStream.on('end', () => resolve(chunks.join('')));
        csvStream.on('error', reject);

        csvData.forEach((row) => csvStream.write(row));
        csvStream.end();
    });
};

// Helper function to fetch NFT owners with retry and exponential backoff
const fetchNftOwnersInBatches = async (collectionTicker, includeSmartContracts) => {
    const apiProvider = "https://api.multiversx.com";
    const MAX_SIZE = 100;
    let addressesArr = [];

    // Fetch total NFT count
    const response = await fetch(`${apiProvider}/collections/${collectionTicker}/nfts/count`);
    const tokensNumber = parseInt(await response.text(), 10);

    // Retry logic with exponential backoff
    const fetchWithRetry = async (url, retries = 5, delay = 1000) => {
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                const response = await fetch(url);
                if (!response.ok) throw new Error(`HTTP Error ${response.status}`);
                return await response.json();
            } catch (error) {
                console.error(`Error fetching data (attempt ${attempt}): ${error.message}`);
                if (attempt === retries) throw error;
                await new Promise(resolve => setTimeout(resolve, delay * attempt)); // Exponential backoff
            }
        }
    };

    // Fetch data in batches to prevent rate limits
    const makeCalls = async () => {
        const repeats = Math.ceil(tokensNumber / MAX_SIZE);
        const throttle = pThrottle({ limit: 2, interval: 1000 }); // Adjust limit dynamically if needed

        const throttled = throttle(async (index) => {
            const url = `${apiProvider}/collections/${collectionTicker}/nfts?withOwner=true&from=${index * MAX_SIZE}&size=${MAX_SIZE}`;
            try {
                const data = await fetchWithRetry(url);
                const addrs = data.map((token) => ({
                    owner: token.owner,
                    identifier: token.identifier,
                    metadataFileName: getMetadataFileName(token.attributes),
                    attributes: token.metadata?.attributes || []
                }));
                addressesArr.push(...addrs);
            } catch (error) {
                console.error(`Failed in batch ${index}: ${error.message}`);
            }
        });

        const promises = [];
        for (let step = 0; step < repeats; step++) {
            promises.push(throttled(step));
        }
        await Promise.all(promises);
    };

    await makeCalls();

    // Exclude smart contract addresses if required
    if (!includeSmartContracts) {
        addressesArr = addressesArr.filter(
            (addrObj) => typeof addrObj.owner === 'string' && !isSmartContractAddress(addrObj.owner)
        );
    }

    return addressesArr;
};


// Helper function to detect if an address is a Smart Contract OR the Burn SC
const isSmartContractAddress = (address) => {
    return address.startsWith('erd1qqqqqqqqqqqqq') || 
           address === 'erd1deaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaqtv0gag'; 
};

// Helper function to decode metadata attributes and get the file name
const getMetadataFileName = (attributes) => {
    const attrsDecoded = attributes
        ? Buffer.from(attributes, 'base64').toString()
        : undefined;
    if (!attrsDecoded) return '';

    const metadataKey = attrsDecoded
        .split(';')
        .filter((item) => item.includes('metadata'))?.[0];

    if (!metadataKey) return '';

    return metadataKey.split('/')?.[1].split('.')?.[0];
};

// Helper function to fetch token details
const fetchTokenDetails = async (token) => {
    try {
        const response = await fetch(`https://api.multiversx.com/tokens/${token}`);
        if (!response.ok) {
            throw new Error(`Failed to fetch token details for "${token}".`);
        }
        return await response.json();
    } catch (error) {
        console.error('Error fetching token details:', error.message);
        throw error;
    }
};

// Function to validate and return the PEM content from the request body (without logging)
const getPemContent = (req) => {
    const pemContent = req.body.walletPem;
    if (!pemContent || typeof pemContent !== 'string' || !pemContent.includes('-----BEGIN PRIVATE KEY-----')) {
        console.error('Invalid PEM content:', pemContent);
        throw new Error('Invalid PEM content');
    }
    return pemContent;
};

// Function to derive the wallet address from a PEM file
const deriveWalletAddressFromPem = (pemContent) => {
    const signer = UserSigner.fromPem(pemContent);
    return signer.getAddress().toString();
};

// Load the whitelist file
const loadWhitelist = () => {
    if (!fs.existsSync(whitelistFilePath)) {
        fs.writeFileSync(whitelistFilePath, JSON.stringify([], null, 2));
    }
    const data = fs.readFileSync(whitelistFilePath);
    return JSON.parse(data);
};

// Check if a wallet is whitelisted
const isWhitelisted = (walletAddress) => {
    const whitelist = loadWhitelist();
    return whitelist.some(entry => entry.walletAddress === walletAddress);
};

// Helper: Fetch REWARD token price from MultiversX API
const getRewardPrice = async () => {
  try {
    const response = await fetch('https://api.elrond.com/tokens?type=FungibleESDT&search=REWARD-cf6eac');
    const data = await response.json();
    const rewardPriceUsd = new BigNumber(data[0].price);

    if (!rewardPriceUsd.isFinite() || rewardPriceUsd.isZero()) {
      throw new Error('Invalid REWARD price fetched from MultiversX API');
    }

    return rewardPriceUsd.toNumber();
  } catch (error) {
    console.error('Error fetching REWARD price:', error);
    throw error;
  }
};

// Helper: Calculate dynamic usage fee based on REWARD price
const calculateDynamicUsageFee = async () => {
  const rewardPrice = await getRewardPrice();
  
  if (rewardPrice <= 0) {
    throw new Error('Invalid REWARD token price');
  }

  const rewardAmount = new BigNumber(FIXED_USD_FEE).dividedBy(rewardPrice);
  const decimals = await getTokenDecimals(REWARD_TOKEN);
  
  // Ensure the amount is not too small or too large
  if (!rewardAmount.isFinite() || rewardAmount.isZero()) {
    throw new Error('Invalid usage fee calculation');
  }

  return convertAmountToBlockchainValue(rewardAmount, decimals);
};

// Helper: Send usage fee transaction
const sendUsageFee = async (pemContent) => {
  const signer = UserSigner.fromPem(pemContent);
  const senderAddress = signer.getAddress();
  const receiverAddress = new Address(TREASURY_WALLET);

  const accountOnNetwork = await provider.getAccount(senderAddress);
  const nonce = accountOnNetwork.nonce;

  // Calculate dynamic fee
  const dynamicFeeAmount = await calculateDynamicUsageFee();

  const factoryConfig = new TransactionsFactoryConfig({ chainID: "1" });
  const factory = new TransferTransactionsFactory({ config: factoryConfig });

  const tx = factory.createTransactionForESDTTokenTransfer({
    sender: senderAddress,
    receiver: receiverAddress,
    tokenTransfers: [
      new TokenTransfer({
        token: new Token({ identifier: REWARD_TOKEN }),
        amount: BigInt(dynamicFeeAmount),
      }),
    ],
  });

  tx.nonce = nonce;
  tx.gasLimit = BigInt(500000);

  await signer.sign(tx);
  const txHash = await provider.sendTransaction(tx);

  const status = await checkTransactionStatus(txHash.toString());
  if (status.status === "fail") {
    throw new Error('Usage fee transaction failed. Ensure sufficient REWARD tokens are available.');
  }
  
  // Return txHash even if status is unknown, we'll consider it a success
  // The blockchain might just need more time to process it
  return txHash.toString();
};

// Middleware: Handle usage fee
const handleUsageFee = async (req, res, next) => {
  try {
    // If request has already paid a fee in this session, skip duplicated processing
    if (req.usageFeeAlreadyProcessed) {
      return next();
    }

    const pemContent = req.body.walletPem;
    if (!pemContent) {
      console.warn('No PEM content provided, skipping usage fee processing.');
      return next();
    }

    const walletAddress = UserSigner.fromPem(pemContent).getAddress().toString();

    if (isWhitelisted(walletAddress)) {
      console.log(`Wallet ${walletAddress} is whitelisted. Skipping usage fee.`);
      return next();
    }

    const txHash = await sendUsageFee(pemContent);
    req.usageFeeHash = txHash;
    
    // Mark this request as having processed a usage fee to prevent double charging
    req.usageFeeAlreadyProcessed = true;
    
    next();
  } catch (error) {
    console.error('Error processing usage fee:', error.message);
    res.status(400).json({ error: error.message });
  }
};

// Apply usage fee middleware to all routes
// app.use(handleUsageFee);

// Helper function to fetch ESDT token details (including decimals)
const fetchTokenDecimals = async (token) => {
    try {
        const response = await fetch(`https://api.multiversx.com/tokens/${token}`);
        if (!response.ok) {
            throw new Error(`Failed to fetch token details for "${token}".`);
        }
        const tokenData = await response.json();
        return tokenData.decimals || 0; // Default to 0 if decimals are missing
    } catch (error) {
        console.error('Error fetching token decimals:', error.message);
        throw error;
    }
};



// Helper function to generate unique owner stats
const generateUniqueOwnerStats = (data, assetType = "NFT", decimals = 0) => {
    const stats = {};

    data.forEach(({ owner, address, balance }) => {
        const account = owner || address; // Handle both NFT (owner) and SFT/ESDT (address)

        if (!account) {
            console.warn("Skipping entry due to missing owner/address:", { owner, address });
            return; // Skip if no valid owner
        }

        if (!stats[account]) {
            stats[account] = 0;
        }

        if (assetType === "NFT") {
            // NFT: Each NFT counts as 1
            stats[account] += 1;
        } else if (assetType === "SFT") {
            // SFT: Whole number (no decimals)
            stats[account] += parseInt(balance || 0, 10);
        } else if (assetType === "ESDT") {
            // ESDT: Convert balance using dynamically fetched decimals
            stats[account] += parseFloat((Number(balance || 0) / 10 ** decimals).toFixed(decimals));
        }
    });

    return Object.entries(stats)
        .map(([account, tokensCount]) => ({
            owner: account,
            tokensCount: assetType === "NFT" || assetType === "SFT" ? tokensCount : tokensCount.toFixed(decimals),
        }))
        .sort((a, b) => parseFloat(b.tokensCount) - parseFloat(a.tokensCount));
};


// NFT Snapshot & Draw Endpoint
app.post('/nftSnapshotDraw', checkToken, handleUsageFee, async (req, res) => {
    try {
        const { collectionTicker, numberOfWinners, includeSmartContracts, traitType, traitValue, fileNamesList } = req.body;

        // Fetch NFT owners
        const addresses = await fetchNftOwnersInBatches(collectionTicker, includeSmartContracts);
        if (addresses.length === 0) {
            return res.status(404).json({ error: 'No addresses found for the collection.' });
        }

        // Apply filtering based on traits if provided
        let filteredAddresses = addresses;
        if (traitType && traitValue) {
            filteredAddresses = filteredAddresses.filter((item) =>
                Array.isArray(item.attributes) &&
                item.attributes.some(attribute => attribute.trait_type === traitType && attribute.value === traitValue)
            );
        }

        // Apply filtering based on metadata file names if provided
        if (fileNamesList && fileNamesList.length > 0) {
            filteredAddresses = filteredAddresses.filter((item) =>
                fileNamesList.includes(item.metadataFileName)
            );
        }

        if (filteredAddresses.length === 0) {
            return res.status(404).json({ error: 'No NFTs found matching the criteria.' });
        }

        // Select random winners
        const shuffled = filteredAddresses.sort(() => 0.5 - Math.random());
        // For NFTs, we don't need to convert balances - an NFT is a single unit
        const winners = shuffled.slice(0, numberOfWinners);

        // Return only winners without CSV or unique owner stats
        res.json({
            winners,
            collectionTicker,
            includeSmartContracts,
            traitType,
            traitValue,
            fileNamesList,
            message: `${numberOfWinners} winners have been selected from collection ${collectionTicker}.`,
            usageFeeHash: req.usageFeeHash, // Attach usage fee hash
        });

    } catch (error) {
        console.error('Error during NFT Snapshot & Draw:', error);
        res.status(500).json({ error: error.message });
    }
});

// NFT Snapshot CSV Data Endpoint
app.post('/nftSnapshotCsv', checkToken, handleUsageFee, async (req, res) => {
    try {
        const { collectionTicker, includeSmartContracts, traitType, traitValue, fileNamesList } = req.body;

        // Fetch NFT owners
        const addresses = await fetchNftOwnersInBatches(collectionTicker, includeSmartContracts);
        if (addresses.length === 0) {
            return res.status(404).json({ error: 'No addresses found for the collection.' });
        }

        // Apply filtering based on traits if provided
        let filteredAddresses = addresses;
        if (traitType && traitValue) {
            filteredAddresses = filteredAddresses.filter((item) =>
                Array.isArray(item.attributes) &&
                item.attributes.some(attribute => attribute.trait_type === traitType && attribute.value === traitValue)
            );
        }

        // Apply filtering based on metadata file names if provided
        if (fileNamesList && fileNamesList.length > 0) {
            filteredAddresses = filteredAddresses.filter((item) =>
                fileNamesList.includes(item.metadataFileName)
            );
        }

        if (filteredAddresses.length === 0) {
            return res.status(404).json({ error: 'No NFTs found matching the criteria.' });
        }

        // Generate CSV string
        const csvString = await generateCsv(filteredAddresses.map(address => ({
            address: address.owner,
            identifier: address.identifier,
            metadataFileName: address.metadataFileName,
            attributes: address.attributes ? JSON.stringify(address.attributes) : '', // Include attributes
        })));

        // Return CSV string
        res.json({
            csvString,
            collectionTicker,
            includeSmartContracts,
            traitType,
            traitValue,
            fileNamesList,
            message: `CSV snapshot for collection ${collectionTicker} has been generated.`,
            usageFeeHash: req.usageFeeHash, // Attach usage fee hash
        });

    } catch (error) {
        console.error('Error during NFT Snapshot CSV Data:', error);
        res.status(500).json({ error: error.message });
    }
});

// NFT Unique Owners Stats Endpoint
app.post('/nftUniqueOwnersStats', checkToken, handleUsageFee, async (req, res) => {
    try {
        const { collectionTicker, includeSmartContracts, traitType, traitValue, fileNamesList } = req.body;

        // Fetch NFT owners
        const addresses = await fetchNftOwnersInBatches(collectionTicker, includeSmartContracts);
        if (addresses.length === 0) {
            return res.status(404).json({ error: 'No addresses found for the collection.' });
        }

        // Apply filtering based on traits if provided
        let filteredAddresses = addresses;
        if (traitType && traitValue) {
            filteredAddresses = filteredAddresses.filter((item) =>
                Array.isArray(item.attributes) &&
                item.attributes.some(attribute => attribute.trait_type === traitType && attribute.value === traitValue)
            );
        }

        // Apply filtering based on metadata file names if provided
        if (fileNamesList && fileNamesList.length > 0) {
            filteredAddresses = filteredAddresses.filter((item) =>
                fileNamesList.includes(item.metadataFileName)
            );
        }

        if (filteredAddresses.length === 0) {
            return res.status(404).json({ error: 'No NFTs found matching the criteria.' });
        }

        // Use the central function for consistent unique owner stats
        const uniqueOwnerStats = generateUniqueOwnerStats(filteredAddresses, "NFT");

        // Return the unique owner stats
        res.json({
            uniqueOwnerStats,
            collectionTicker,
            includeSmartContracts,
            traitType,
            traitValue,
            fileNamesList,
            message: `Unique owner statistics for collection ${collectionTicker} have been generated.`,
            usageFeeHash: req.usageFeeHash, // Attach usage fee hash
        });

    } catch (error) {
        console.error('Error during NFT Unique Owners Stats:', error);
        res.status(500).json({ error: error.message });
    }
});


// Helper function to fetch SFT owners
const fetchSftOwners = async (collectionTicker, editions, includeSmartContracts) => {
    const apiProvider = "https://api.multiversx.com";
    const owners = [];
    const size = 1000; // API allows fetching up to 1000 owners per call

    try {
        for (const edition of editions) {
            const editionTicker = `${collectionTicker}-${edition}`;
            let hasMore = true;
            let from = 0;

            while (hasMore) {
                const response = await fetch(
                    `${apiProvider}/nfts/${editionTicker}/accounts?size=${size}&from=${from}`
                );

                if (!response.ok) {
                    console.error('API response:', response.status, await response.text());
                    throw new Error(`Failed to fetch owners for SFT edition "${editionTicker}".`);
                }

                const data = await response.json();
                if (data.length === 0) {
                    hasMore = false;
                } else {
                    const filteredOwners = data.filter(owner =>
                        includeSmartContracts || !isSmartContractAddress(owner.address)
                    );

                    filteredOwners.forEach(owner => {
                        owners.push({
                            address: owner.address,
                            balance: owner.balance,
                        });
                    });

                    from += size;
                    hasMore = data.length === size;
                }
            }
        }

        return owners;
    } catch (error) {
        console.error('Error fetching SFT owners:', error.message);
        throw error;
    }
};

// SFT Snapshot & Draw Endpoint
app.post('/sftSnapshotDraw', checkToken, handleUsageFee, async (req, res) => {
    try {
        const { collectionTicker, editions, numberOfWinners, includeSmartContracts } = req.body;

        if (!collectionTicker || !editions || !numberOfWinners) {
            return res.status(400).json({ error: 'Missing required parameters: collectionTicker, editions, numberOfWinners' });
        }

        // Convert editions input to an array (e.g., "01,02,03" -> ["01", "02", "03"])
        const editionArray = editions.split(',').map(e => e.trim());

        // Fetch SFT owners
        const sftOwners = await fetchSftOwners(collectionTicker, editionArray, includeSmartContracts);
        if (sftOwners.length === 0) {
            return res.status(404).json({ error: 'No SFT owners found for the specified collection and editions' });
        }

        // ✅ Generate unique owner stats with updated function
        const uniqueOwnerStats = generateUniqueOwnerStats(sftOwners, "SFT");

        // Randomly select winners
        const shuffled = sftOwners.sort(() => 0.5 - Math.random());
        const winners = shuffled.slice(0, numberOfWinners);

        // Generate CSV for all SFT owners
        const csvString = await generateCsv(sftOwners.map(owner => ({
            address: owner.address,
            balance: owner.balance,
        })));

        // Response payload
        res.json({
            winners,
            uniqueOwnerStats, // ✅ This now includes proper owners & integer token counts
            totalOwners: sftOwners.length,
            message: `${numberOfWinners} winners have been selected from the SFT collection "${collectionTicker}" across editions "${editions}".`,
            csvString,
            usageFeeHash: req.usageFeeHash, // Attach usage fee hash
        });

    } catch (error) {
        console.error('Error during SFT Snapshot & Draw:', error);
        res.status(500).json({ error: error.message });
    }
});

// Helper function to fetch ESDT owners in batches with retry and throttling
const fetchEsdtOwners = async (token, includeSmartContracts) => {
    const owners = new Map();
    const batchSize = 1000; // Max batch size per API call
    let from = 0;
    let totalFetched = 0;
    const maxRetries = 5;

    console.log(`Fetching owners for ESDT: ${token}`);

    const fetchWithRetry = async (url, retries = maxRetries, delay = 1000) => {
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                const response = await fetch(url);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                return await response.json();
            } catch (error) {
                console.warn(`Fetch failed (attempt ${attempt}): ${error.message}`);
                if (attempt === retries) throw error;
                await new Promise(resolve => setTimeout(resolve, delay * attempt)); // Exponential backoff
            }
        }
    };

    const makeBatchRequests = async () => {
        while (true) {
            const url = `https://api.multiversx.com/tokens/${token}/accounts?size=${batchSize}&from=${from}`;
            console.log(`Fetching batch: ${from} - ${from + batchSize}`);

            try {
                const data = await fetchWithRetry(url);

                if (!data || data.length === 0) break;

                data.forEach(owner => {
                    if (includeSmartContracts || (!isSmartContractAddress(owner.address) && owner.address !== "erd1deaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaqtv0gag")) {
                        owners.set(owner.address, {
                            address: owner.address,
                            balance: owner.balance,
                        });
                    }
                });

                from += batchSize;
                totalFetched += data.length;

                console.log(`Total owners fetched: ${totalFetched}`);

                // API Limit: Allow a 2-second pause between batches
                await new Promise(resolve => setTimeout(resolve, 2000));

                // Stop if we reach 100k owners (to prevent excessive load)
                if (totalFetched >= 100000) {
                    console.warn('Reached 100,000 owners. Stopping further requests.');
                    break;
                }

            } catch (error) {
                console.error('Error fetching ESDT owners:', error.message);
                throw error;
            }
        }
    };

    await makeBatchRequests();

    return Array.from(owners.values());
};


// ESDT Snapshot & Draw Endpoint
app.post('/esdtSnapshotDraw', checkToken, handleUsageFee, async (req, res) => {
    try {
        const { token, includeSmartContracts, numberOfWinners } = req.body;

        if (!token || !numberOfWinners) {
            return res.status(400).json({ error: 'Missing required parameters: token, numberOfWinners' });
        }

        console.log(`Starting ESDT snapshot for token: ${token}`);

        // Step 1: Fetch Token Decimals
        const decimals = await fetchTokenDecimals(token);

        // Step 2: Fetch Token Owners in Batches with API Throttling
        const esdtOwners = await fetchEsdtOwners(token, includeSmartContracts);

        if (esdtOwners.length === 0) {
            return res.status(404).json({ error: `No owners found for token: ${token}` });
        }

        console.log(`Fetched ${esdtOwners.length} ESDT owners`);

        // Step 3: Generate Unique Owner Stats
        const uniqueOwnerStats = generateUniqueOwnerStats(esdtOwners, "ESDT", decimals);

        // Step 4: Select Random Winners
        const shuffled = esdtOwners.sort(() => 0.5 - Math.random());
        const winners = shuffled.slice(0, numberOfWinners).map(winner => ({
            ...winner,
            balance: (Number(winner.balance || 0) / 10 ** decimals).toFixed(decimals)
        }));

        // Step 5: Generate CSV Output
        const csvString = await generateCsv(esdtOwners.map(owner => ({
            address: owner.address,
            balance: (Number(owner.balance || 0) / 10 ** decimals).toFixed(decimals),
        })));

        res.json({
            token,
            decimals,
            totalOwners: esdtOwners.length,
            uniqueOwnerStats,
            winners,
            csvString,
            message: `${numberOfWinners} winners have been selected from token "${token}".`,
            usageFeeHash: req.usageFeeHash,
        });

    } catch (error) {
        console.error('Error during ESDT Snapshot & Draw:', error);
        res.status(500).json({ error: error.message });
    }
});


// Helper: fetchWithRetry wraps fetch with retries on failure (e.g. rate limit errors).
async function fetchWithRetry(url, options = {}, retries = 15, backoff = 2000) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, options);
      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After');
        const delay = retryAfter ? Number(retryAfter) * 1000 : backoff;
        console.log(`Rate limit hit for ${url}. Retrying in ${delay}ms... (attempt ${i + 1})`);
        await new Promise(res => setTimeout(res, delay));
        backoff *= 2;
        continue;
      }
      if (!response.ok) {
        console.error(`Non-OK response (${response.status}) for ${url}. Retrying in ${backoff}ms... (attempt ${i + 1})`);
        await new Promise(res => setTimeout(res, backoff));
        backoff *= 2;
        continue;
      }
      return response;
    } catch (error) {
      console.error(`Error fetching ${url}: ${error.message}. Retrying in ${backoff}ms... (attempt ${i + 1})`);
      await new Promise(res => setTimeout(res, backoff));
      backoff *= 2;
    }
  }
  throw new Error(`Failed to fetch ${url} after ${retries} retries`);
}

// Helper: Async Pool - limits concurrency of async tasks.
async function asyncPool(poolLimit, array, iteratorFn) {
  const ret = [];
  const executing = [];
  for (const item of array) {
    const p = Promise.resolve().then(() => iteratorFn(item));
    ret.push(p);
    if (poolLimit <= array.length) {
      const e = p.then(() => executing.splice(executing.indexOf(e), 1));
      executing.push(e);
      if (executing.length >= poolLimit) {
        await Promise.race(executing);
      }
    }
  }
  return Promise.all(ret);
}

// Helper function to fetch all paginated transactions using "from" based pagination.
const fetchAllTransactions = async (baseUrl) => {
  let allTransactions = [];
  let from = 0;
  const batchSize = 1000;
  let currentBatchSize = batchSize;
  do {
    // Append &from= to the URL
    const url = `${baseUrl}&from=${from}`;
    const response = await fetchWithRetry(url);
    const result = await response.json();
    // Assuming the API returns an array directly (or under .data)
    const transactions = result.data || result;
    console.log(`Fetched ${transactions.length} transactions from ${url}`);
    allTransactions.push(...transactions);
    currentBatchSize = transactions.length;
    from += batchSize;
  } while (currentBatchSize === batchSize);
  console.log(`Total transactions fetched: ${allTransactions.length}`);
  return allTransactions;
};

// Helper function to fetch all NFTs held by the smart contract for the given collection using "from" pagination.
const fetchScNfts = async (contractAddress, collectionTicker) => {
  let allNfts = [];
  let from = 0;
  const batchSize = 500;
  let currentBatchSize = batchSize;
  do {
    const url = `https://api.multiversx.com/accounts/${contractAddress}/nfts?size=${batchSize}&collections=${collectionTicker}&from=${from}`;
    const response = await fetchWithRetry(url);
    const result = await response.json();
    const nfts = result.data || result;
    console.log(`Fetched ${nfts.length} NFTs from ${url}`);
    allNfts.push(...nfts);
    currentBatchSize = nfts.length;
    from += batchSize;
  } while (currentBatchSize === batchSize);
  console.log(`Total NFTs in smart contract: ${allNfts.length}`);
  return allNfts;
};

// Updated helper function to fetch staked NFTs using staking events,
// then validate them in bulk using the smart contract's NFT inventory.
const fetchStakedNfts = async (collectionTicker, contractLabel) => {
  const contractAddresses = {
    oneDexStakedNfts: "erd1qqqqqqqqqqqqqpgqrq6gv0ljf4y9md42pe4m6mh96hcpqnpuusls97tf33",
    xoxnoStakedNfts: "erd1qqqqqqqqqqqqqpgqvpkd3g3uwludduv3797j54qt6c888wa59w2shntt6z",
    artCpaStakedNfts: "erd1qqqqqqqqqqqqqpgqfken0exk7jpr85dx6f8ym3jgcagesfcqkqys0xnquf",
    hodlFounderNfts: "erd1qqqqqqqqqqqqqpgqpvlxt3n9ks66kuq4j8cvcv25k8a5rsx99g6suw5r66",
  };

  const stakingFunctions = {
    oneDexStakedNfts: "userStake",
    xoxnoStakedNfts: "stake",
    artCpaStakedNfts: "userStake",
    hodlFounderNfts: "stake",
  };

  const contractAddress = contractAddresses[contractLabel];
  const stakeFunction = stakingFunctions[contractLabel];

  if (!contractAddress || !stakeFunction) {
    throw new Error("Unsupported contract label or staking function");
  }

  try {
    const baseUrl = `https://api.multiversx.com/accounts/${contractAddress}/transfers?size=1000&token=${collectionTicker}`;
    const allTransactions = await fetchAllTransactions(baseUrl);
    const successfulTxs = allTransactions
      .filter(tx => tx.status === "success")
      .sort((a, b) => Number(a.timestamp) - Number(b.timestamp));

    // Collect raw staking events (with duplicates) from successful transactions.
    const rawStakedEvents = [];
    successfulTxs.forEach(tx => {
      const transfers = (tx.action?.arguments?.transfers || []).filter(
        transfer => transfer.collection === collectionTicker
      );
      transfers.forEach(item => {
        if (tx.function === stakeFunction) {
          rawStakedEvents.push({
            txHash: tx.hash || tx.nonce,
            timestamp: tx.timestamp,
            function: tx.function,
            identifier: item.identifier,
            sender: tx.sender
          });
        } else {
          console.log(`Ignoring NFT ${item.identifier} from tx ${tx.hash || tx.nonce} with function "${tx.function}"`);
        }
      });
    });

    // Log raw events in a CSV-friendly format.
    const header = "txHash,timestamp,function,identifier,sender";
    const csvRows = rawStakedEvents.map(e =>
      `${e.txHash},${e.timestamp},${e.function},${e.identifier},${e.sender}`
    );
    const csvString = [header, ...csvRows].join("\n");
    console.log("Raw staked NFT events (CSV format):\n" + csvString);

    // Fetch the current NFTs held by the smart contract.
    const scNfts = await fetchScNfts(contractAddress, collectionTicker);
    const validNftIds = new Set(scNfts.map(nft => nft.identifier));
    console.log(`Valid NFT identifiers fetched from smart contract: ${[...validNftIds].join(', ')}`);

    // Filter raw events based on whether the NFT identifier is in the SC list.
    const validatedResults = rawStakedEvents.filter(event => validNftIds.has(event.identifier))
      .map(event => ({ owner: event.sender, identifier: event.identifier }));
    console.log(`📊 Validated staked NFT count (may contain duplicates): ${validatedResults.length}`);

    // Deduplicate the final validated results by NFT identifier.
    const dedupedNfts = Array.from(new Map(validatedResults.map(nft => [nft.identifier, nft])).values());
    console.log(`📊 Deduplicated staked NFT count: ${dedupedNfts.length}`);
    return dedupedNfts;
  } catch (error) {
    console.error("Error fetching staked NFTs data:", error.message);
    throw error;
  }
};

// ------------------ Endpoint ------------------

// Route for staked NFTs snapshot draw
app.post('/stakedNftsSnapshotDraw', checkToken, handleUsageFee, async (req, res) => {
  try {
    const { collectionTicker, contractLabel, numberOfWinners } = req.body;
    const stakedData = await fetchStakedNfts(collectionTicker, contractLabel);
    if (stakedData.length === 0) {
      return res.status(404).json({ error: 'No staked NFTs found for this collection' });
    }
    const totalStakedCount = stakedData.length;

    // Generate unique owner statistics (each NFT counts as 1)
    const uniqueOwnerStats = generateUniqueOwnerStats(stakedData, "NFT");

    // Randomly shuffle the staked NFTs and pick winners
    const shuffled = stakedData.sort(() => 0.5 - Math.random());
    const winners = shuffled.slice(0, numberOfWinners);
    const csvString = await generateCsv(stakedData);

    res.json({
      winners,
      totalStakedCount,
      uniqueOwnerStats,
      csvString,
      message: `${numberOfWinners} winners have been selected from staked NFTs in collection ${collectionTicker}.`,
      usageFeeHash: req.usageFeeHash,
    });
  } catch (error) {
    console.error('Error during stakedNftsSnapshotDraw:', error);
    res.status(500).json({ error: `Failed to fetch staked NFTs: ${error.message}` });
  }
});

// Helper function to fetch staked ESDT tokens by tracking staking and unstaking events
const fetchStakedEsdts = async (token, stakingContractAddress) => {
  if (!stakingContractAddress) {
    throw new Error("Staking smart contract address is required");
  }

  try {
    console.log(`Fetching staked ESDT tokens for ${token} from contract ${stakingContractAddress}`);
    
    // Fetch all token transfers involving the staking contract
    const baseUrl = `https://api.multiversx.com/accounts/${stakingContractAddress}/transfers?size=1000&token=${token}`;
    console.log(`Fetching transactions from ${baseUrl}`);
    const allTransactions = await fetchAllTransactions(baseUrl);
    
    const successfulTxs = allTransactions
      .filter(tx => tx.status === "success")
      .sort((a, b) => Number(a.timestamp) - Number(b.timestamp)); // Sort chronologically
    
    console.log(`Found ${successfulTxs.length} successful transactions for token ${token}`);

    // Track user balances by processing staking and unstaking events chronologically
    const userBalances = {};
    let totalStaked = BigInt(0);
    
    // Process all transactions chronologically
    successfulTxs.forEach(tx => {
      // Skip transactions without action or arguments
      if (!tx.action || !tx.action.arguments) return;
      
      const transfers = tx.action.arguments.transfers || [];
      if (!transfers.length) return;
      
      // Identify the relevant transfer for our token
      const relevantTransfer = transfers.find(t => t.token === token || t.ticker === token);
      if (!relevantTransfer) return;
      
      const amount = BigInt(relevantTransfer.value || '0');
      if (amount === BigInt(0)) return;
      
      // CASE 1: Staking event (User → SC, function is stake/userStake)
      if ((tx.function === 'stake' || tx.function === 'userStake') && 
          tx.receiver === stakingContractAddress) {
        
        const user = tx.sender;
        if (!userBalances[user]) userBalances[user] = BigInt(0);
        
        userBalances[user] += amount;
        totalStaked += amount;
        
        console.log(`[STAKING] User ${user} staked ${amount.toString()} tokens at ${new Date(tx.timestamp * 1000).toISOString()}`);
      }
      
      // CASE 2: Unstaking event (SC → User, function is ESDTTransfer)
      else if (tx.function === 'ESDTTransfer' && 
               tx.sender === stakingContractAddress) {
        
        const user = tx.receiver;
        if (!userBalances[user]) userBalances[user] = BigInt(0);
        
        // Make sure we don't go below zero
        if (userBalances[user] >= amount) {
          userBalances[user] -= amount;
          totalStaked -= amount;
          console.log(`[UNSTAKING] User ${user} unstaked ${amount.toString()} tokens at ${new Date(tx.timestamp * 1000).toISOString()}`);
        } else {
          console.warn(`Warning: Unstaking event would result in negative balance for user ${user}. Setting to 0.`);
          totalStaked -= userBalances[user];
          userBalances[user] = BigInt(0);
        }
      }
      
      // There may be other relevant transactions like rewards distribution
      // but for the staking calculation we focus on stake/unstake events
    });
    
    console.log(`Total staked amount calculated from transactions: ${totalStaked.toString()}`);
    
    // Validate the calculated total against the current contract balance
    const contractBalance = BigInt(await fetchContractTokenBalance(stakingContractAddress, token));
    console.log(`Current contract balance: ${contractBalance.toString()}`);
    
    // If there's a significant discrepancy, log it but continue with the calculated values
    // This can happen due to rewards distribution or other SC operations
    if (contractBalance > totalStaked) {
      console.log(`Contract balance exceeds calculated staked amount by ${(contractBalance - totalStaked).toString()} tokens`);
    } else if (totalStaked > contractBalance) {
      console.log(`Calculated staked amount exceeds contract balance by ${(totalStaked - contractBalance).toString()} tokens`);
    }
    
    // Convert the user balances map to the expected format for the API response
    const stakedData = Object.entries(userBalances)
      .filter(([_, balance]) => balance > BigInt(0))
      .map(([address, balance]) => ({
        address,
        balance: balance.toString()
      }));
    
    console.log(`Found ${stakedData.length} addresses with staked ${token} tokens`);
    return stakedData;
    
  } catch (error) {
    console.error("Error fetching staked ESDT tokens data:", error.message);
    throw error;
  }
};

// Helper to fetch a contract's token balance
const fetchContractTokenBalance = async (contractAddress, token) => {
  try {
    const response = await fetch(`https://api.multiversx.com/accounts/${contractAddress}/tokens/${token}`);
    
    // If token not found in the account, return 0
    if (response.status === 404) {
      return "0";
    }
    
    if (!response.ok) {
      throw new Error(`Error fetching token balance: ${response.status} ${response.statusText}`);
    }
    
    const data = await response.json();
    return data.balance || "0";
  } catch (error) {
    console.error(`Error fetching ${token} balance for ${contractAddress}:`, error.message);
    return "0"; // Return 0 on error
  }
};

// Route for staked ESDT tokens snapshot draw
app.post('/stakedEsdtsSnapshotDraw', checkToken, handleUsageFee, async (req, res) => {
  try {
    const { token, stakingContractAddress, numberOfWinners } = req.body;
    
    if (!token || !stakingContractAddress || !numberOfWinners) {
      return res.status(400).json({ 
        error: 'Missing required parameters: token, stakingContractAddress, numberOfWinners' 
      });
    }
    
    // Step 1: Fetch Token Decimals
    const decimals = await fetchTokenDecimals(token);
    console.log(`Token ${token} has ${decimals} decimals`);
    
    // Step 2: Fetch staked data
    const stakedData = await fetchStakedEsdts(token, stakingContractAddress);
    
    if (stakedData.length === 0) {
      return res.status(404).json({ error: 'No staked tokens found for this token and contract' });
    }
    
    const totalStakedCount = stakedData.length;
    console.log(`Found ${totalStakedCount} stakers`);

    // Step 3: Generate unique owner statistics with proper decimal conversion
    const uniqueOwnerStats = generateUniqueOwnerStats(stakedData, "ESDT", decimals);

    // Step 4: Randomly shuffle the stakers and pick winners
    const shuffled = stakedData.sort(() => 0.5 - Math.random());
    // Apply proper decimal formatting to winners
    const winners = shuffled.slice(0, numberOfWinners).map(winner => ({
      ...winner,
      balance: (Number(winner.balance || 0) / 10 ** decimals).toFixed(decimals)
    }));
    
    // Step 5: Generate CSV with properly formatted balances 
    const csvString = await generateCsv(stakedData.map(staker => ({
      address: staker.address,
      balance: (Number(staker.balance || 0) / 10 ** decimals).toFixed(decimals)
    })));

    res.json({
      token,
      stakingContractAddress,
      totalStakers: stakedData.length,
      uniqueOwnerStats,
      winners,
      csvString,
      message: `${numberOfWinners} winners have been selected from stakers of ${token}.`,
      usageFeeHash: req.usageFeeHash,
    });
  } catch (error) {
    console.error('Error during stakedEsdtsSnapshotDraw:', error);
    res.status(500).json({ error: `Failed to fetch staked ESDT tokens: ${error.message}` });
  }
});

// ------------------ Start Server ------------------
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
