import * as cheerio from "cheerio";
import { chromium } from "playwright";

interface WordleApiResp {
	id: number;
	solution: string;
	days_since_launch: number;
	print_date: string;
	editor: string;
}

interface FormattedWordleData extends WordleApiResp {
	date: number;
	letters: Array<{ char: string; status: string }>;
	error: boolean;
}

interface HintResponse {
	hint: { consonant: string; vowel: string };
	difficulty: {
		difficulty: number | null;
		maxDifficulty: number | null;
		text: string | null;
	};
	details: {
		definition: string | null;
		source: { name: string | null; url: string };
	};
}

async function fetchAnswer(timestamp: number): Promise<FormattedWordleData> {
	const now = new Date(timestamp);
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	const formattedDate = `${year}-${month}-${day}`;

	const apiUrl = `https://www.nytimes.com/svc/wordle/v2/${formattedDate}.json`;

	console.log(`Fetching Wordle answer: ${apiUrl}`);

	const browser = await chromium.launch({
		headless: true,
		args: ["--no-sandbox", "--disable-setuid-sandbox"],
	});

	try {
		const page = await browser.newPage({
			userAgent:
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
		});

		const response = await page.goto(apiUrl, { waitUntil: "domcontentloaded" });

		if (!response || !response.ok()) {
			throw new Error(`API request failed: ${response?.status()}`);
		}

		const data = (await response.json()) as WordleApiResp;

		return {
			...data,
			date: now.getTime(),
			letters: data.solution.split("").map((char) => ({
				char: char.toUpperCase(),
				status: "correct",
			})),
			error: false,
		};
	} finally {
		await browser.close();
	}
}

async function fetchHintsByNavigation(
	_puzzleId: number,
): Promise<HintResponse> {
	const browser = await chromium.launch({
		headless: true, // Set to true once it works
		args: ["--no-sandbox", "--disable-setuid-sandbox"],
	});

	try {
		const context = await browser.newContext({
			userAgent:
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
			viewport: { width: 1920, height: 1080 },
		});

		const page = await context.newPage();

		console.log("Going to Wordle...");
		await page.goto("https://www.nytimes.com/games/wordle/index.html", {
			waitUntil: "domcontentloaded",
			timeout: 30000,
		});

		console.log("Setting localStorage...");
		await page.evaluate(() => {
			localStorage.setItem("wordle-help-dismissed", "1");
		});

		console.log("Reloading...");
		await page.reload({ waitUntil: "domcontentloaded" });

		console.log("Waiting for Play button...");
		const playButton = await page.waitForSelector(
			'button[data-testid="Play"]',
			{
				state: "visible",
				timeout: 30000,
			},
		);

		console.log("Clicking Play button...");
		await playButton.click();
		await page.waitForTimeout(1000);

		console.log("Waiting for Close button...");
		const closeButton = await page.waitForSelector(
			'button[aria-label="Close"]',
			{
				state: "visible",
				timeout: 10000,
			},
		);

		console.log("Clicking Close button...");
		await closeButton.click();
		await page.waitForTimeout(1000);

		console.log("Waiting for Hints button...");
		const hintsButton = await page.waitForSelector('a[href*="wordle-review"]', {
			state: "visible",
			timeout: 30000,
		});

		const hintsUrl = await hintsButton.getAttribute("href");
		console.log(`Hints URL: ${hintsUrl}`);

		console.log("Clicking Hints button...");
		await Promise.all([
			hintsButton.click(),
			page.waitForURL("**/crosswords/wordle-review-**", { timeout: 30000 }),
		]);

		console.log(`On hints page: ${page.url()}`);

		// Wait for content to load
		console.log("Waiting for content to load...");
		await page.waitForTimeout(5000);

		// Get HTML
		const html = await page.content();

		// Save for debugging
		await Bun.write("debug-hints-page.html", html);
		console.log("Saved HTML to debug-hints-page.html");

		// Parse with Cheerio
		const $ = cheerio.load(html);

		// Extract hints
		console.log("\nExtracting data...");

		let consonant = "";
		let vowel = "";
		const revealBlocks = $('[data-testid="reveal-block"]');

		console.log(`   Found ${revealBlocks.length} reveal blocks`);

		revealBlocks.each((i, block) => {
			const $block = $(block);
			const buttonText = $block.find('[role="button"]').text().trim();
			const revealText = $block
				.find(".show, .css-wndcfh")
				.text()
				.trim()
				.toUpperCase();

			console.log(`   Block ${i + 1}: "${buttonText}" -> "${revealText}"`);

			if (buttonText.toLowerCase().includes("consonant") && !consonant) {
				consonant = revealText;
			} else if (buttonText.toLowerCase().includes("vowel") && !vowel) {
				vowel = revealText;
			}
		});

		// Extract difficulty
		let difficultyText = $("strong.css-8qgvsz").text();
		if (!difficultyText) difficultyText = $(".css-ac37hb strong").text();
		if (!difficultyText) {
			difficultyText = $("strong")
				.filter((_, el) => $(el).text().includes("guesses"))
				.text();
		}

		console.log(`   Difficulty text: "${difficultyText}"`);

		const difficultyMatch = difficultyText.match(
			/(\d+(?:\.\d+)?) guesses out of (\d+)/,
		);
		const friendlyText = difficultyText.match(/, or ([^.]+)\./)?.[1] ?? null;

		const difficulty = difficultyMatch?.[1]
			? Number.parseFloat(difficultyMatch[1])
			: null;
		const maxDifficulty = difficultyMatch?.[2]
			? Number.parseFloat(difficultyMatch[2])
			: null;

		// Extract dictionary name and definition
		let dictionaryName: string | null = null;
		let definition: string | null = null;

		$("a").each((_, el) => {
			const text = $(el).text();
			if (text.includes("According to") && !dictionaryName) {
				const match = text.match(/According to ([^,]+),?/);
				if (match?.[1]) dictionaryName = match[1].trim();
			}
		});

		$("p").each((_, el) => {
			const text = $(el).text();
			if (text.includes("it means") && text.length < 500 && !definition) {
				const defMatch = text.match(/it means "([^"]+)"/i);
				if (defMatch?.[1]) definition = defMatch[1].trim();
			}
		});

		console.log(`   Dictionary: ${dictionaryName}`);
		console.log(`   Definition: ${definition}`);

		return {
			hint: { consonant, vowel },
			difficulty: { difficulty, maxDifficulty, text: friendlyText },
			details: {
				definition,
				source: { name: dictionaryName, url: page.url() },
			},
		};
	} finally {
		await browser.close();
	}
}

async function scrapeAndSave(timestamp?: number) {
	const ts = timestamp || Date.now();
	const date = new Date(ts);
	const dateStr = date.toISOString().split("T")[0];

	console.log(`\nScraping Wordle for ${dateStr}...\n`);

	try {
		// Fetch answer from API
		const wordleData = await fetchAnswer(ts);

		if (wordleData.error) {
			throw new Error("Failed to fetch Wordle data");
		}

		console.log(`\nGot answer: ${wordleData.solution.toUpperCase()}`);
		console.log(`   Puzzle #${wordleData.days_since_launch}\n`);

		// Fetch hints by navigating
		const hintData = await fetchHintsByNavigation(wordleData.days_since_launch);

		const combinedData = {
			wordleData,
			hintData,
			scrapedAt: Date.now(),
		};

		// Save to file
		const dataDir = `${process.cwd()}/data`;
		await Bun.write(`${dataDir}/.gitkeep`, "");
		const filePath = `${dataDir}/${dateStr}.json`;

		await Bun.write(filePath, JSON.stringify(combinedData, null, 2));

		console.log(`\nSuccess!`);
		console.log(`   File: ${filePath}`);
		console.log(`   Solution: ${wordleData.solution.toUpperCase()}`);
		console.log(`   Puzzle #${wordleData.days_since_launch}`);
		console.log(`   Consonant: ${hintData.hint.consonant || "N/A"}`);
		console.log(`   Vowel: ${hintData.hint.vowel || "N/A"}`);
		console.log(
			`   Difficulty: ${hintData.difficulty.difficulty || "N/A"}/${hintData.difficulty.maxDifficulty || "?"}`,
		);

		return combinedData;
	} catch (error) {
		console.error(`\nError:`, error);
		throw error;
	}
}

if (import.meta.main) {
	scrapeAndSave()
		.then(() => process.exit(0))
		.catch((error) => {
			console.error(error);
			process.exit(1);
		});
}

export { scrapeAndSave, fetchAnswer, fetchHintsByNavigation };
