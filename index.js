import { Address } from '@multiversx/sdk-core';
import fetch from 'node-fetch';
import pThrottle from 'p-throttle';
import express from 'express';
import bodyParser from 'body-parser';
import { format as formatCsv } from 'fast-csv';

// App initialization
const app = express();
const PORT = process.env.PORT || 10000;

// Constants and configurations
const apiProvider = {
    mainnet: process.env.API_PROVIDER || 'https://api.multiversx.com',
    devnet: process.env.DEVNET_PROVIDER || 'https://devnet-api.multiversx.com',
};
const SECURE_TOKEN = process.env.SECURE_TOKEN; // Secure Token for authorization
const MAX_SIZE = 100; // Maximum batch size for fetching data
const RETRY_LIMIT = 3; // Retry limit for API requests

// Middleware setup
app.use(bodyParser.json()); // Support JSON-encoded bodies

// Middleware to check authorization token for protected routes
const checkToken = (req, res, next) => {
    const token = req.headers.authorization;
    if (token === `Bearer ${SECURE_TOKEN}`) {
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized' });
    }
};

// Authorization endpoint to verify connection
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

// Contract configuration using environment variables
const contractConfig = {
    oneDexStakedNfts: {
        address: process.env.ONEDEX_STAKE_ADDRESS || "erd1qqqqqqqqqqqqqpgqrq6gv0ljf4y9md42pe4m6mh96hcpqnpuusls97tf33",
        functionName: process.env.ONEDEX_STAKE_FUNCTION || "userStake",
    },
    xoxnoStakedNfts: {
        address: process.env.XOXNO_STAKE_ADDRESS || "erd1qqqqqqqqqqqqqpgqvpkd3g3uwludduv3797j54qt6c888wa59w2shntt6z",
        functionName: process.env.XOXNO_STAKE_FUNCTION || "stake",
    },
    artCpaStakedNfts: {
        address: process.env.ARTCPA_STAKE_ADDRESS || "erd1qqqqqqqqqqqqqpgqfken0exk7jpr85dx6f8ym3jgcagesfcqkqys0xnquf",
        functionName: process.env.ARTCPA_STAKE_FUNCTION || "userStake",
    },
    // Add additional contracts here if needed
};

// Helper function to fetch contract configuration based on the label
const getContractConfig = (contractLabel) => {
    const config = contractConfig[contractLabel];
    if (!config) {
        throw new Error(`Unsupported contract label: ${contractLabel}`);
    }
    return config;
};

// Generalized helper function to fetch data with retry logic
const fetchData = async (url, retries = RETRY_LIMIT) => {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`HTTP Error ${response.status}`);
            }
            return await response.json();
        } catch (error) {
            console.error(`Error fetching data (attempt ${attempt}): ${error.message}`);
            if (attempt === retries) {
                throw error; // Re-throw error after exhausting retries
            }
            await new Promise(resolve => setTimeout(resolve, 2000 * attempt)); // Exponential backoff
        }
    }
};

// Helper function to fetch and calculate currently staked NFTs
const fetchStakedNfts = async (collectionTicker, contractLabel) => {
    const { address, functionName } = getContractConfig(contractLabel);

    try {
        const fetchPaginatedData = async (baseUrl) => {
            let allData = [];
            let page = 0;
            let data;

            do {
                const url = `${baseUrl}&from=${page * MAX_SIZE}`;
                data = await fetchData(url);
                allData = allData.concat(data);
                page++;
            } while (data.length === MAX_SIZE);

            return allData;
        };

        const stakedData = await fetchPaginatedData(
            `${apiProvider.mainnet}/accounts/${address}/transfers?size=1000&token=${collectionTicker}&status=success&function=${functionName}`
        );

        const unstakedData = await fetchPaginatedData(
            `${apiProvider.mainnet}/accounts/${address}/transfers?size=1000&token=${collectionTicker}&status=success&function=ESDTNFTTransfer`
        );

        const allTransactions = [...stakedData, ...unstakedData].sort(
            (a, b) => a.timestamp - b.timestamp || a.nonce - b.nonce
        );

        const stakedNfts = new Map();

        console.log('All transactions:', allTransactions);

        allTransactions.forEach(tx => {
            const transfers = tx.action?.arguments?.transfers?.filter(
                transfer => transfer.collection === collectionTicker
            ) || [];

            transfers.forEach(item => {
                if (tx.function === functionName) {
                    // Stake transaction: Add to stakedNfts
                    if (stakedNfts.has(item.identifier)) {
                        console.warn(`Duplicate stake detected for NFT: ${item.identifier}`);
                    } else {
                        stakedNfts.set(item.identifier, {
                            owner: tx.sender,
                            identifier: item.identifier,
                        });
                        console.log(`Staked: ${item.identifier} by ${tx.sender}`);
                    }
                } else if (tx.function === 'ESDTNFTTransfer' && tx.sender === address) {
                    // Unstake transaction: Remove from stakedNfts
                    if (!stakedNfts.has(item.identifier)) {
                        console.warn(`Unstake event for non-staked NFT: ${item.identifier}`);
                    } else {
                        const unstakeReceiver = tx.receiver || 'Unknown Receiver';
                        stakedNfts.delete(item.identifier);
                        console.log(`Unstaked: ${item.identifier}, Receiver: ${unstakeReceiver}`);
                    }
                }
            });
        });

        const uniqueStakedCount = new Set(stakedNfts.keys()).size;
        console.log(`Final unique staked NFTs count: ${uniqueStakedCount}`);
        return Array.from(stakedNfts.values());

    } catch (error) {
        console.error("Error fetching staked NFTs data:", error.message);
        throw error;
    }
};

// Function to generate CSV data as a string (includes all NFTs in the snapshot)
const generateCsv = async (data) => {
    const csvData = [];

    data.forEach((row) => {
        csvData.push({
            owner: row.owner,
            identifier: row.identifier,
            metadataFileName: row.metadataFileName || '',
            attributes: JSON.stringify(row.attributes || []), // Store attributes as JSON string
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

// Function to generate unique owner stats
const generateUniqueOwnerStats = (data) => {
    const stats = {};
    data.forEach(({ owner }) => {
        if (!stats[owner]) {
            stats[owner] = 0;
        }
        stats[owner]++;
    });

    return Object.entries(stats).map(([owner, tokensCount]) => ({
        owner,
        tokensCount,
    }));
};

// Route for snapshotDraw
app.post('/snapshotDraw', checkToken, async (req, res) => {
    try {
        const { collectionTicker, numberOfWinners, includeSmartContracts, traitType, traitValue, fileNamesList } = req.body;

        // Fetch NFT owners
        let addresses = await fetchData(
            `${apiProvider.mainnet}/collections/${collectionTicker}/nfts?withOwner=true&size=1000`
        );

        if (!includeSmartContracts) {
            addresses = addresses.filter(
                (item) => typeof item.owner === 'string' && !item.owner.startsWith('erd1qqqqqqqqqqqqq')
            );
        }

        if (addresses.length === 0) {
            return res.status(404).json({ error: 'No addresses found' });
        }

        // Filter by traitType and traitValue if provided
        if (traitType && traitValue) {
            addresses = addresses.filter((item) =>
                Array.isArray(item.metadata?.attributes) &&
                item.metadata.attributes.some(attribute => {
                    return attribute.trait_type === traitType && attribute.value === traitValue;
                })
            );
        }

        // Filter by fileNamesList if provided
        if (fileNamesList && fileNamesList.length > 0) {
            addresses = addresses.filter((item) =>
                fileNamesList.includes(item.metadataFileName)
            );
        }

        if (addresses.length === 0) {
            return res.status(404).json({ error: 'No NFTs found matching the criteria' });
        }

        // Select random winners
        const shuffled = addresses.sort(() => 0.5 - Math.random());
        const winners = shuffled.slice(0, numberOfWinners).map((winner) => ({
            owner: winner.owner,
            identifier: winner.identifier,
            metadataFileName: winner.metadataFileName,
        }));

        // Generate unique owner stats
        const uniqueOwnerStats = generateUniqueOwnerStats(addresses);

        // Generate CSV as a string with all NFTs in the snapshot (not just winners)
        const csvString = await generateCsv(addresses);

        // Respond with the full NFT snapshot, winners, and unique stats
        res.json({
            winners,
            uniqueOwnerStats,
            message: `${numberOfWinners} winners have been selected from collection ${collectionTicker}.`,
            csvString,
        });
    } catch (error) {
        console.error('Error during snapshotDraw:', error);
        res.status(500).json({ error: error.message });
    }
});

// Updated endpoint for staked NFTs snapshot draw
app.post('/stakedNftsSnapshotDraw', checkToken, async (req, res) => {
    try {
        const { collectionTicker, contractLabel, numberOfWinners } = req.body;

        // Fetch staked NFTs and their owners
        const stakedData = await fetchStakedNfts(collectionTicker, contractLabel);
        if (stakedData.length === 0) {
            return res.status(404).json({ error: 'No staked NFTs found for this collection' });
        }

        // Count total staked NFTs
        const totalStakedCount = stakedData.length;

        // Random selection of winners
        const shuffled = stakedData.sort(() => 0.5 - Math.random());
        const winners = shuffled.slice(0, numberOfWinners).map((winner) => ({
            owner: winner.owner,
            identifier: winner.identifier,
        }));

        // Generate CSV with all staked NFTs
        const csvString = await generateCsv(stakedData);

        // Response includes selected winners, total staked count, and CSV snapshot
        res.json({
            winners,
            totalStakedCount,
            message: `${numberOfWinners} winners have been selected from staked NFTs in collection ${collectionTicker}.`,
            csvString,
        });
    } catch (error) {
        console.error('Error during stakedNftsSnapshotDraw:', error);
        res.status(500).json({ error: error.message });
    }
});

// Throttle configuration: 5 requests per second
const throttle = pThrottle({
    limit: 5,      // Maximum of 5 requests
    interval: 1000 // Per 1000 ms (1 second)
});

// Helper function to fetch data with throttling
const fetchDataWithThrottle = async (url, retries = RETRY_LIMIT) => {
    const fetchThrottled = throttle(async (url) => {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`HTTP Error ${response.status}`);
        }
        return await response.json();
    });

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            return await fetchThrottled(url);
        } catch (error) {
            console.error(`Error fetching data (attempt ${attempt}): ${error.message}`);
            if (attempt === retries) {
                throw error; // Re-throw error after exhausting retries
            }
            await new Promise(resolve => setTimeout(resolve, 2000 * attempt)); // Exponential backoff
        }
    }
};

// Start the server
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
