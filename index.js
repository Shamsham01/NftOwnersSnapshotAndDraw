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

// Helper function to detect if the address is a Smart Contract
const isSmartContractAddress = (address) => {
    return address.startsWith('erd1qqqqqqqqqqqqq');
};

// Helper function to fetch NFT owners with retries and error handling
const fetchNftOwners = async (collectionTicker, includeSmartContracts) => {
    let tokensNumber = '0';
    const addressesArr = [];

    const response = await fetch(
        `${apiProvider.mainnet}/collections/${collectionTicker}/nfts/count`
    );
    tokensNumber = await response.text();

    const makeCalls = () =>
        new Promise((resolve) => {
            const repeats = Math.ceil(Number(tokensNumber) / MAX_SIZE);
            const throttle = pThrottle({
                limit: 2,      // 2 requests per second (per MultiversX API limit)
                interval: 1000 // 1000 ms (1 second)
            });

            let madeRequests = 0;

            const throttled = throttle(async (index, retries = 0) => {
                try {
                    const response = await fetch(
                        `${apiProvider.mainnet}/collections/${collectionTicker}/nfts?withOwner=true&from=${
                            index * MAX_SIZE
                        }&size=${MAX_SIZE}`
                    );
                    
                    if (!response.ok) throw new Error(`HTTP Error ${response.status}`);

                    const contentType = response.headers.get('content-type');
                    if (contentType && contentType.includes('application/json')) {
                        const data = await response.json();
                        
                        const addrs = data.map((token) => ({
                            owner: token.owner,
                            identifier: token.identifier,
                            metadataFileName: getMetadataFileName(token.attributes),  // Extract metadata file name
                            attributes: token.metadata?.attributes || []  // Save full attributes for filtering
                        }));

                        addressesArr.push(addrs);
                        madeRequests++;
                    } else {
                        throw new Error('Invalid response type, expected JSON');
                    }

                    if (madeRequests >= repeats) {
                        return resolve(addressesArr.flat());
                    }

                } catch (error) {
                    if (retries < RETRY_LIMIT) {
                        console.error(`Retrying request (attempt ${retries + 1}) for batch ${index}: ${error.message}`);
                        await throttled(index, retries + 1);  // Retry
                    } else {
                        console.error(`Failed after ${RETRY_LIMIT} attempts for batch ${index}: ${error.message}`);
                    }
                }
            });

            for (let step = 0; step < repeats; step++) {
                throttled(step);
            }
        });

    let addresses = await makeCalls();

    if (!includeSmartContracts) {
        addresses = addresses.filter(
            (addrObj) => 
                typeof addrObj.owner === 'string' && !isSmartContractAddress(addrObj.owner)
        );
    }

    return addresses;
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

// Function to generate CSV data as a string
const generateCsv = async (data) => {
    const csvData = [];

    data.forEach((row) => {
        csvData.push({
            address: row.address || row.owner, // Use `address` for SFTs, `owner` for NFTs
            identifier: row.identifier || '', // Include identifier if available
            balance: row.balance || '', // Include balance if available
            metadataFileName: row.metadataFileName || '', // Include metadata if available
            attributes: row.attributes ? JSON.stringify(row.attributes) : '' // Store attributes as JSON string
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

    // Iterate through all entries and aggregate the balances
    data.forEach(({ address, balance }) => {
        if (!stats[address]) {
            stats[address] = 0;
        }
        stats[address] += parseInt(balance, 10); // Ensure balance is treated as a number
    });

    // Convert the stats object into an array of owner statistics and sort by count
    return Object.entries(stats)
        .map(([address, count]) => ({
            owner: address,
            tokensCount: count,
        }))
        .sort((a, b) => b.tokensCount - a.tokensCount); // Sort by tokensCount descending
};

// Route for snapshotDraw
app.post('/snapshotDraw', checkToken, async (req, res) => {
    try {
        const { collectionTicker, numberOfWinners, includeSmartContracts, traitType, traitValue, fileNamesList } = req.body;

        // Fetch NFT owners
        let addresses = await fetchNftOwners(collectionTicker, includeSmartContracts);
        if (addresses.length === 0) {
            return res.status(404).json({ error: 'No addresses found' });
        }

        // Filter by traitType and traitValue if provided
        if (traitType && traitValue) {
            addresses = addresses.filter((item) =>
                Array.isArray(item.attributes) &&
                item.attributes.some(attribute => {
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
        const winners = [];
        const shuffled = addresses.sort(() => 0.5 - Math.random());
        const selected = shuffled.slice(0, numberOfWinners);

        selected.forEach((winner) => {
            winners.push({
                owner: winner.owner,
                identifier: winner.identifier,
                metadataFileName: winner.metadataFileName,
            });
        });

        // Generate unique owner stats
        const uniqueOwnerStats = generateUniqueOwnerStats(addresses);

        // Generate CSV string for all NFT owners
        const csvString = await generateCsv(addresses);

        // Respond with the full NFT snapshot, winners, and unique stats
        res.json({
            winners,
            uniqueOwnerStats, // Include unique owner stats here
            message: `${numberOfWinners} winners have been selected from collection ${collectionTicker}.`,
            csvString, // Returning the CSV string of all NFTs considered in the draw
        });
    } catch (error) {
        console.error('Error during snapshotDraw:', error);
        res.status(500).json({ error: error.message });
    }
});


// Throttle configuration: 2 requests per second
const throttle = pThrottle({
    limit: 2,      // Maximum of 4 requests
    interval: 1000 // Per 1000 ms (1 second)
});

// Helper function to fetch data with throttling and retry logic
const fetchDataWithRetry = async (url, retries = 3) => {
    const fetchThrottled = throttle(async (url) => {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`HTTP Error ${response.status}`);
        }
        return await response.json();
    });

    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await fetchThrottled(url);
        } catch (error) {
            if (attempt < retries && error.message.includes("HTTP Error 429")) {
                console.warn(`Retrying due to rate limit... (Attempt ${attempt + 1} of ${retries})`);
                await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second before retrying
            } else {
                throw error;
            }
        }
    }
    throw new Error("Failed to fetch data after retries.");
};

// Helper function to fetch and calculate currently staked NFTs for /stakedNftsSnapshotDraw
const fetchStakedNfts = async (collectionTicker, contractLabel) => {
    const contractAddresses = {
        oneDexStakedNfts: "erd1qqqqqqqqqqqqqpgqrq6gv0ljf4y9md42pe4m6mh96hcpqnpuusls97tf33",
        xoxnoStakedNfts: "erd1qqqqqqqqqqqqqpgqvpkd3g3uwludduv3797j54qt6c888wa59w2shntt6z",
        artCpaStakedNfts: "erd1qqqqqqqqqqqqqpgqfken0exk7jpr85dx6f8ym3jgcagesfcqkqys0xnquf",
        hodlFounderNFTs: "erd1qqqqqqqqqqqqqpgqpvlxt3n9ks66kuq4j8cvcv25k8a5rsx99g6suw5r66",
        // Add additional contracts here if needed
    };

    // Define the staking function names for each contract
    const stakingFunctions = {
        oneDexStakedNfts: "userStake",
        xoxnoStakedNfts: "stake",
        artCpaStakedNfts: "userStake",
        hodlFounderNFT: "stake",
        // Add other contract function mappings as needed
    };

    const contractAddress = contractAddresses[contractLabel];
    const stakeFunction = stakingFunctions[contractLabel];

    if (!contractAddress || !stakeFunction) {
        throw new Error("Unsupported contract label or staking function");
    }

    // Helper function to fetch data with retry logic
    const fetchData = async (url, retries = 3) => {
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                const response = await fetch(url);
                if (!response.ok) {
                    throw new Error(`HTTP Error ${response.status}`);
                }
                return await response.json();
            } catch (error) {
                console.error(`Error fetching data (attempt ${attempt}):`, error.message);
                if (attempt === retries) throw error;
                await new Promise(resolve => setTimeout(resolve, 2000 * attempt)); // Exponential backoff
            }
        }
    };

    try {
        // Fetch both staked and unstaked data using the correct function name for staking
        const stakedData = await fetchData(
            `${apiProvider.mainnet}/accounts/${contractAddress}/transfers?size=1000&token=${collectionTicker}&status=success&function=${stakeFunction}`
        );

        const unstakedData = await fetchData(
            `${apiProvider.mainnet}/accounts/${contractAddress}/transfers?size=1000&token=${collectionTicker}&status=success&function=ESDTNFTTransfer`
        );

        // Combine and sort all transactions by timestamp
        const allTransactions = [...stakedData, ...unstakedData].sort((a, b) => a.timestamp - b.timestamp);

        const stakedNfts = new Map();

        // Process transactions in chronological order
        allTransactions.forEach(tx => {
            const transfers = tx.action?.arguments?.transfers?.filter(
                transfer => transfer.collection === collectionTicker
            ) || [];

            transfers.forEach(item => {
                if (tx.function === stakeFunction) {
                    // Stake transaction: mark NFT as staked by setting owner
                    stakedNfts.set(item.identifier, {
                        owner: tx.sender,
                        identifier: item.identifier
                    });
                } else if (tx.function === 'ESDTNFTTransfer' && tx.sender === contractAddress) {
                    // Unstake transaction: remove NFT from staked list
                    stakedNfts.delete(item.identifier);
                }
            });
        });

        const stakedList = Array.from(stakedNfts.values());
        console.log(`Total staked NFTs found: ${stakedList.length}`);
        return stakedList;

    } catch (error) {
        console.error("Error fetching staked NFTs data:", error);
        throw error;
    }
};


// Updated endpoint for staked NFTs snapshot draw
app.post('/stakedNftsSnapshotDraw', checkToken, async (req, res) => {
    try {
        const { collectionTicker, contractLabel, numberOfWinners } = req.body;

        // Fetch staked NFTs and their owners with filters
        const stakedData = await fetchStakedNfts(collectionTicker, contractLabel);
        if (stakedData.length === 0) {
            return res.status(404).json({ error: 'No staked NFTs found for this collection' });
        }

        // Count total staked NFTs
        const totalStakedCount = stakedData.length;

        // Random selection of winners
        const shuffled = stakedData.sort(() => 0.5 - Math.random());
        const winners = shuffled.slice(0, numberOfWinners);

        // Generate CSV string for all staked NFTs
        const csvString = await generateCsv(stakedData);

        // Response includes selected winners, total staked count, and CSV snapshot
        res.json({
            winners,
            totalStakedCount, // Adding total number of staked NFTs to response
            message: `${numberOfWinners} winners have been selected from staked NFTs in collection ${collectionTicker}.`,
            csvString, // All staked NFTs data as CSV
        });
    } catch (error) {
        console.error('Error during stakedNftsSnapshotDraw:', error);
        res.status(500).json({ error: error.message });
    }
});


// Updated endpoint for SFT snapshot draw
app.post('/sftSnapshotDraw', checkToken, async (req, res) => {
    try {
        const { collectionTicker, editions, numberOfWinners, includeSmartContracts } = req.body;

        if (!collectionTicker || !editions || !numberOfWinners) {
            return res.status(400).json({ error: 'Missing required parameters: collectionTicker, editions, numberOfWinners' });
        }

        // Split editions string into an array (e.g., "01,02,03" -> ["01", "02", "03"])
        const editionArray = editions.split(',').map(e => e.trim());

        // Fetch SFT owners
        const sftOwners = await fetchSftOwners(collectionTicker, editionArray, includeSmartContracts);
        if (sftOwners.length === 0) {
            return res.status(404).json({ error: 'No SFT owners found for the specified collection and editions' });
        }

        // Generate unique owner stats
        const uniqueOwnerStats = generateUniqueOwnerStats(sftOwners);

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
            uniqueOwnerStats, // Include unique owner stats
            totalOwners: sftOwners.length,
            message: `${numberOfWinners} winners have been selected from the SFT collection "${collectionTicker}" across editions "${editions}".`,
            csvString,
        });
    } catch (error) {
        console.error('Error during sftSnapshotDraw:', error);
        res.status(500).json({ error: error.message });
    }
});


// Helper function to fetch SFT owners
const fetchSftOwners = async (collectionTicker, editions, includeSmartContracts) => {
    const owners = [];
    const size = 1000; // API allows fetching up to 1000 owners per call

    try {
        // Loop through each edition provided by the user
        for (const edition of editions) {
            const editionTicker = `${collectionTicker}-${edition}`;
            let hasMore = true;
            let from = 0;

            // Fetch owners in batches
            while (hasMore) {
                const response = await fetch(
                    `${apiProvider.mainnet}/nfts/${editionTicker}/accounts?size=${size}&from=${from}`
                );

                if (!response.ok) {
                    console.error('API response:', response.status, await response.text());
                    throw new Error(`Failed to fetch owners for SFT edition "${editionTicker}".`);
                }

                const data = await response.json();
                if (data.length === 0) {
                    hasMore = false; // No more owners to fetch
                } else {
                    // Filter out smart contracts if specified
                    const filteredOwners = data.filter(owner =>
                        includeSmartContracts || !isSmartContractAddress(owner.address)
                    );

                    // Add owners to the result array
                    filteredOwners.forEach(owner => {
                        owners.push({
                            address: owner.address,
                            balance: owner.balance,
                        });
                    });

                    // Move to the next page
                    from += size;
                    hasMore = data.length === size; // If less than 1000, we reached the end
                }
            }
        }

        return owners;
    } catch (error) {
        console.error('Error fetching SFT owners:', error.message);
        throw error;
    }
};

// Helper function for fetch with retry logic and exponential backoff
const fetchWithRetry = async (url, retries = 3) => {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`HTTP Error ${response.status}`);
            }
            return await response.json();
        } catch (error) {
            if (attempt < retries && error.message.includes("HTTP Error 429")) {
                console.warn(`Rate limit hit. Retrying in ${2 ** attempt} seconds... (Attempt ${attempt})`);
                await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt)); // Exponential backoff
            } else {
                console.error(`Failed after ${attempt} attempts:`, error.message);
                throw error;
            }
        }
    }
    throw new Error("Exceeded maximum retry attempts");
};

// Helper function to fetch ESDT owners
const fetchEsdtOwners = async (token, includeSmartContracts) => {
    const owners = new Map();
    const size = 1000; // Max batch size
    let from = 0;

    try {
        while (true) {
            const url = `${apiProvider.mainnet}/tokens/${token}/accounts?size=${size}&from=${from}`;
            const data = await fetchWithRetry(url);

            if (!data || data.length === 0) {
                break; // No more data
            }

            data.forEach(owner => {
                if (includeSmartContracts || !isSmartContractAddress(owner.address)) {
                    owners.set(owner.address, {
                        address: owner.address,
                        balance: owner.balance,
                    });
                }
            });

            from += size;

            // Stop fetching if we reach a large number of results
            if (owners.size >= 100000) {
                console.warn('Fetched 100,000 unique owners. Stopping further processing.');
                break;
            }
        }

        return Array.from(owners.values());
    } catch (error) {
        console.error('Error fetching ESDT owners:', error.message);
        throw error;
    }
};

// Helper function to fetch token details
const fetchTokenDetails = async (token) => {
    try {
        const response = await fetch(`${apiProvider.mainnet}/tokens/${token}`);
        if (!response.ok) {
            throw new Error(`Failed to fetch token details for "${token}".`);
        }
        return await response.json();
    } catch (error) {
        console.error('Error fetching token details:', error.message);
        throw error;
    }
};

// Updated endpoint for ESDT Snapshot Draw
app.post('/esdtSnapshotDraw', checkToken, async (req, res) => {
    try {
        const { token, includeSmartContracts, numberOfWinners } = req.body;

        if (!token || !numberOfWinners) {
            return res.status(400).json({ error: 'Missing required parameters: token, numberOfWinners' });
        }

        // Fetch token details to get decimals
        const tokenDetails = await fetchTokenDetails(token);
        const decimals = tokenDetails.decimals || 0;

        // Fetch token owners
        const esdtOwners = await fetchEsdtOwners(token, includeSmartContracts);

        if (esdtOwners.length === 0) {
            return res.status(404).json({ error: 'No owners found for the specified token.' });
        }

        // Convert balances to human-readable format
        const humanReadableOwners = esdtOwners.map(owner => ({
            address: owner.address,
            balance: (BigInt(owner.balance) / BigInt(10 ** decimals)).toString(), // Convert to human-readable
        }));

        // Generate unique owner stats
        const uniqueOwnerStats = generateUniqueOwnerStats(humanReadableOwners);

        // Randomly select winners
        const shuffled = humanReadableOwners.sort(() => 0.5 - Math.random());
        const winners = shuffled.slice(0, numberOfWinners);

        // Generate CSV string for all token owners
        const csvString = await generateCsv(humanReadableOwners);

        // Respond with the snapshot including unique owner stats
        res.json({
            token,
            decimals,
            totalOwners: esdtOwners.length,
            uniqueOwnerStats, // Include unique owner stats here
            winners,
            csvString,
            message: `${numberOfWinners} winners have been selected from the token "${token}".`,
        });
    } catch (error) {
        console.error('Error during esdtSnapshotDraw:', error);
        res.status(500).json({ error: error.message });
    }
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
