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
const USAGE_FEE = 500; // Fee in REWARD tokens
const REWARD_TOKEN = "REWARD-cf6eac"; // Token identifier
const TREASURY_WALLET = "erd158k2c3aserjmwnyxzpln24xukl2fsvlk9x46xae4dxl5xds79g6sdz37qn"; // Treasury wallet
const provider = new ProxyNetworkProvider("https://gateway.multiversx.com", { clientName: "javascript-api" });

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

            if (!response.ok) {
                console.warn(`Non-200 response for ${txHash}: ${response.status}`);
                throw new Error(`HTTP error ${response.status}`);
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
        }

        await new Promise(resolve => setTimeout(resolve, delay));
    }

    throw new Error(
        `Transaction ${txHash} status could not be determined after ${retries} retries.`
    );
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


// Helper function to detect if the address is a Smart Contract
const isSmartContractAddress = (address) => {
    return address.startsWith('erd1qqqqqqqqqqqqq');
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

// Function to send usage fee
const sendUsageFee = async (pemContent) => {
    const signer = UserSigner.fromPem(pemContent);
    const senderAddress = signer.getAddress();
    const receiverAddress = new Address(TREASURY_WALLET);

    const accountOnNetwork = await provider.getAccount(senderAddress);
    const nonce = accountOnNetwork.nonce;

    const decimals = await getTokenDecimals(REWARD_TOKEN);
    const convertedAmount = convertAmountToBlockchainValue(USAGE_FEE, decimals);

    const factoryConfig = new TransactionsFactoryConfig({ chainID: "1" });
    const factory = new TransferTransactionsFactory({ config: factoryConfig });

    const tx = factory.createTransactionForESDTTokenTransfer({
        sender: senderAddress,
        receiver: receiverAddress,
        tokenTransfers: [
            new TokenTransfer({
                token: new Token({ identifier: REWARD_TOKEN }),
                amount: BigInt(convertedAmount),
            }),
        ],
    });

    tx.nonce = nonce;
    tx.gasLimit = BigInt(500000);

    await signer.sign(tx);
    const txHash = await provider.sendTransaction(tx);

    const status = await checkTransactionStatus(txHash.toString());
    if (status.status !== "success") {
        throw new Error('UsageFee transaction failed. Ensure sufficient REWARD tokens are available.');
    }
    return txHash.toString();
};

// Middleware to handle usage fee
const handleUsageFee = async (req, res, next) => {
    try {
        const pemContent = getPemContent(req);
        const walletAddress = deriveWalletAddressFromPem(pemContent);

        // Check if the wallet is whitelisted
        if (isWhitelisted(walletAddress)) {
            console.log(`Wallet ${walletAddress} is whitelisted. Skipping usage fee.`);
            next(); // Skip the usage fee and proceed
            return;
        }

        const txHash = await sendUsageFee(pemContent);
        req.usageFeeHash = txHash; // Attach transaction hash to the request
        next();
    } catch (error) {
        console.error('Error processing UsageFee:', error.message);
        res.status(400).json({ error: error.message });
    }
};

// Helper function to generate unique owner stats
const generateUniqueOwnerStats = (data) => {
    const stats = {};

    data.forEach(({ owner }) => {
        if (!stats[owner]) {
            stats[owner] = 0;
        }
        stats[owner] += 1; // Each NFT counts as 1 for the owner
    });

    return Object.entries(stats)
        .map(([owner, tokensCount]) => ({ owner, tokensCount }))
        .sort((a, b) => b.tokensCount - a.tokensCount);
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
        const winners = shuffled.slice(0, numberOfWinners).map(winner => ({
            owner: winner.owner,
            identifier: winner.identifier,
            metadataFileName: winner.metadataFileName,
        }));

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

        // Generate unique owner stats
        const uniqueOwnerStats = filteredAddresses.reduce((stats, item) => {
            if (!stats[item.owner]) {
                stats[item.owner] = 0;
            }
            stats[item.owner] += 1; // Increment the count for each NFT owned
            return stats;
        }, {});

        const uniqueOwnerStatsArray = Object.entries(uniqueOwnerStats).map(([owner, tokensCount]) => ({
            owner,
            tokensCount,
        }));

        uniqueOwnerStatsArray.sort((a, b) => b.tokensCount - a.tokensCount); // Sort descending by token count

        // Return the unique owner stats
        res.json({
            uniqueOwnerStats: uniqueOwnerStatsArray,
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

// Route for SFT snapshot draw
app.post('/sftSnapshotDraw', checkToken, handleUsageFee, async (req, res) => {
    try {
        const { collectionTicker, editions, numberOfWinners, includeSmartContracts } = req.body;

        if (!collectionTicker || !editions || !numberOfWinners) {
            return res.status(400).json({ error: 'Missing required parameters: collectionTicker, editions, numberOfWinners' });
        }

        const editionArray = editions.split(',').map(e => e.trim());

        const sftOwners = await fetchSftOwners(collectionTicker, editionArray, includeSmartContracts);
        if (sftOwners.length === 0) {
            return res.status(404).json({ error: 'No SFT owners found for the specified collection and editions' });
        }

        const uniqueOwnerStats = generateUniqueOwnerStats(sftOwners);

        const shuffled = sftOwners.sort(() => 0.5 - Math.random());
        const winners = shuffled.slice(0, numberOfWinners);

        // Generate CSV string
        const csvString = await generateCsv(sftOwners);

        res.json({
            winners,
            uniqueOwnerStats,
            csvString,
            totalOwners: sftOwners.length,
            message: `${numberOfWinners} winners have been selected from the SFT collection "${collectionTicker}" across editions "${editions}".`,
            usageFeeHash: req.usageFeeHash,
        });
    } catch (error) {
        console.error('Error during sftSnapshotDraw:', error);
        res.status(500).json({ error: error.message });
    }
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
