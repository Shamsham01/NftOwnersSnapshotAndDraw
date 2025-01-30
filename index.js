import { Address } from '@multiversx/sdk-core';
import fetch from 'node-fetch';
import ora from 'ora';
import pThrottle from 'p-throttle';
import express from 'express';
import bodyParser from 'body-parser';
import { ProxyNetworkProvider } from '@multiversx/sdk-network-providers';
import { UserSigner } from '@multiversx/sdk-wallet';
import { format as formatCsv } from 'fast-csv';
import { Readable } from 'stream';

const app = express();
const PORT = process.env.PORT || 10000;
const SECURE_TOKEN = process.env.SECURE_TOKEN;  // Secure Token for authorization
const MAX_SIZE = 100;
const RETRY_LIMIT = 3;  // Retry limit for API requests
const apiProvider = {
  mainnet: 'https://api.multiversx.com',
  devnet: 'https://devnet-api.multiversx.com',
};  // Change based on network

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

// Helper function to fetch NFT owners in optimized batches
const fetchNftOwners = async (collectionTicker, includeSmartContracts) => {
    const apiProvider = "https://api.multiversx.com";
    let tokensNumber = '0';
    const addressesArr = [];

    const response = await fetch(
        `${apiProvider}/collections/${collectionTicker}/nfts/count`
    );
    tokensNumber = await response.text();

    const makeCalls = async () => {
        const repeats = Math.ceil(Number(tokensNumber) / 100);
        const throttle = pThrottle({
            limit: 2,
            interval: 1000
        });

        let madeRequests = 0;
        const throttled = throttle(async (index) => {
            try {
                const response = await fetch(
                    `${apiProvider}/collections/${collectionTicker}/nfts?withOwner=true&from=${
                        index * 100
                    }&size=100`
                );

                if (!response.ok) throw new Error(`HTTP Error ${response.status}`);

                const data = await response.json();

                const addrs = data.map((token) => ({
                    owner: token.owner,
                    identifier: token.identifier,
                    metadataFileName: getMetadataFileName(token.attributes),
                    attributes: token.metadata?.attributes || []
                }));

                addressesArr.push(...addrs);
                madeRequests++;
            } catch (error) {
                console.error(`Error in batch ${index}:`, error.message);
            }

            if (madeRequests >= repeats) {
                return addressesArr.flat();
            }
        });

        const promises = [];
        for (let step = 0; step < repeats; step++) {
            promises.push(throttled(step));
        }
        await Promise.all(promises);
    };

    await makeCalls();

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

// Function to check if a wallet is whitelisted
const isWhitelisted = (walletAddress) => {
    const whitelistedWallets = process.env.WHITELISTED_WALLETS?.split(',') || [];
    return whitelistedWallets.includes(walletAddress);
};

// Function to send the usage fee transaction
const sendUsageFee = async (pemContent) => {
    try {
        const signer = UserSigner.fromPem(pemContent);
        const senderAddress = signer.getAddress();

        const accountOnNetwork = await provider.getAccount(senderAddress);
        const senderNonce = accountOnNetwork.nonce;

        const tx = new Transaction({
            nonce: senderNonce,
            receiver: new Address(process.env.USAGE_FEE_RECEIVER),
            sender: senderAddress,
            value: process.env.USAGE_FEE_AMOUNT,
            gasLimit: 50000, // Standard gas limit
            data: new TransactionPayload("Usage Fee Payment"),
            chainID: '1',
        });

        await signer.sign(tx);
        const txHash = await provider.sendTransaction(tx);
        return txHash.toString();
    } catch (error) {
        console.error("Error sending usage fee:", error.message);
        throw new Error("Usage fee transaction failed.");
    }
};

// Middleware to process the usage fee payment
const handleUsageFee = async (req, res, next) => {
    try {
        const pemContent = getPemContent(req);
        const walletAddress = deriveWalletAddressFromPem(pemContent);

        // Skip the usage fee if the wallet is whitelisted
        if (isWhitelisted(walletAddress)) {
            console.log(`Wallet ${walletAddress} is whitelisted. Skipping usage fee.`);
            next();
            return;
        }

        // Execute the usage fee transaction
        const txHash = await sendUsageFee(pemContent);
        req.usageFeeHash = txHash; // Attach transaction hash to the request
        next();
    } catch (error) {
        console.error('Error processing UsageFee:', error.message);
        res.status(400).json({ error: error.message });
    }
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

// Helper function to decode metadata attributes and get the file name
const getMetadataFileName = (attributes) => {
    const attrsDecoded = attributes ? Buffer.from(attributes, 'base64').toString() : undefined;
    if (!attrsDecoded) return '';

    const metadataKey = attrsDecoded
        .split(';')
        .filter((item) => item.includes('metadata'))?.[0];

    return metadataKey ? metadataKey.split('/')?.[1].split('.')?.[0] : '';
};

// Helper function to check if an address is a smart contract
const isSmartContractAddress = (address) => {
    return address.startsWith('erd1qqqqqqqqqqqqq');
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

// Helper function to generate a CSV data string
const generateCsv = async (data) => {
    const csvData = data.map(row => ({
        address: row.owner,
        identifier: row.identifier,
        metadataFileName: row.metadataFileName || '',
        attributes: row.attributes ? JSON.stringify(row.attributes) : '',
    }));

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

// Start the server
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
