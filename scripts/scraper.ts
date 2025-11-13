import { chromium } from "playwright";
import * as cheerio from "cheerio";

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

	console.log(`📡 Fetching Wordle answer: ${apiUrl}`);

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

async function fetchHintsDirectly(hintsUrl: string): Promise<HintResponse> {
	console.log(`📄 Fetching hints from: ${hintsUrl}`);

	const browser = await chromium.launch({
		headless: true, // Can set to false for debugging
		args: ["--no-sandbox", "--disable-setuid-sandbox"],
	});

	try {
		const page = await browser.newPage({
			userAgent:
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
			viewport: { width: 1920, height: 1080 },
		});

		await page.goto(hintsUrl, {
			waitUntil: "domcontentloaded",
			timeout: 60000,
		});

		console.log("⏳ Waiting for content...");
		await page.waitForTimeout(5000);

		const html = await page.content();

		// Save for debugging
		await Bun.write("debug-hints.html", html);
		console.log("💾 Saved HTML to debug-hints.html");

		const $ = cheerio.load(html);

		console.log("\n📊 Extracting data...");

		// Extract hints
		let consonant = "";
		let vowel = "";
		const revealBlocks = $('[data-testid="reveal-block"]');

		console.log(`   Found ${revealBlocks.length} reveal blocks`);

		revealBlocks.each((i, block) => {
			const $block = $(block);
			const buttonText = $block.find('[role="button"]').text().trim();
			const revealText = $block
				.find(".show, .css-wndcfh, p")
				.text()
				.trim()
				.toUpperCase();

			console.log(`   Block ${i + 1}: "${buttonText}" -> "${revealText}"`);

			if (buttonText.toLowerCase().includes("consonant") && !consonant) {
				consonant = revealText.charAt(0) || revealText;
			} else if (buttonText.toLowerCase().includes("vowel") && !vowel) {
				vowel = revealText.charAt(0) || revealText;
			}
		});

		// Extract difficulty
		let difficultyText = "";
		$("strong").each((_, el) => {
			const text = $(el).text();
			if (text.includes("guesses")) {
				difficultyText = text;
			}
		});

		console.log(`   Difficulty text: "${difficultyText}"`);

		const difficultyMatch = difficultyText.match(
			/(\d+(?:\.\d+)?) guesses out of (\d+)/,
		);
		const friendlyText = difficultyText.match(/, or ([^.]+)\./)?.[1] ?? null;

		const difficulty = difficultyMatch
			? Number.parseFloat(difficultyMatch[1])
			: null;
		const maxDifficulty = difficultyMatch
			? Number.parseFloat(difficultyMatch[2])
			: null;

		// Extract dictionary name and definition
		let dictionaryName: string | null = null;
		let definition: string | null = null;

		$("a").each((_, el) => {
			const text = $(el).text();
			if (text.includes("According to") && !dictionaryName) {
				const match = text.match(/According to ([^,]+),?/);
				if (match) dictionaryName = match[1].trim();
			}
		});

		$("p").each((_, el) => {
			const text = $(el).text();
			if (text.includes("it means") && text.length < 500 && !definition) {
				const defMatch = text.match(/it means "([^"]+)"/i);
				if (defMatch) definition = defMatch[1].trim();
			}
		});

		console.log(`   Consonant: ${consonant || "❌"}`);
		console.log(`   Vowel: ${vowel || "❌"}`);
		console.log(`   Dictionary: ${dictionaryName || "❌"}`);
		console.log(`   Definition: ${definition || "❌"}`);

		return {
			hint: { consonant, vowel },
			difficulty: { difficulty, maxDifficulty, text: friendlyText },
			details: {
				definition,
				source: { name: dictionaryName, url: hintsUrl },
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

	console.log(`\n🎯 Scraping Wordle for ${dateStr}...\n`);

	try {
		// Fetch answer from API
		const wordleData = await fetchAnswer(ts);

		if (wordleData.error) {
			throw new Error("Failed to fetch Wordle data");
		}

		console.log(`\n✅ Got answer: ${wordleData.solution.toUpperCase()}`);
		console.log(`   Puzzle #${wordleData.days_since_launch}\n`);

		// Build hints URL
		const hintDate = new Date(ts);
		hintDate.setDate(hintDate.getDate() - 1); // Hints are published day before

		const year = hintDate.getFullYear();
		const month = String(hintDate.getMonth() + 1).padStart(2, "0");
		const day = String(hintDate.getDate()).padStart(2, "0");

		const hintsUrl = `https://www.nytimes.com/${year}/${month}/${day}/crosswords/wordle-review-${wordleData.days_since_launch}.html`;

		// Fetch hints
		const hintData = await fetchHintsDirectly(hintsUrl);

		const combinedData = {
			wordleData,
			hintData,
			scrapedAt: Date.now(),
		};

		// Save to file
		const dataDir = `${process.cwd()}/public/data/wordle`;
		await Bun.write(`${dataDir}/.gitkeep`, "");
		const filePath = `${dataDir}/${dateStr}.json`;

		await Bun.write(filePath, JSON.stringify(combinedData, null, 2));

		console.log(`\n✅ Success!`);
		console.log(`   File: ${filePath}`);
		console.log(`   Solution: ${wordleData.solution.toUpperCase()}`);
		console.log(`   Puzzle #${wordleData.days_since_launch}`);
		console.log(`   Consonant: ${hintData.hint.consonant || "❌"}`);
		console.log(`   Vowel: ${hintData.hint.vowel || "❌"}`);
		console.log(
			`   Difficulty: ${hintData.difficulty.difficulty || "❌"}/${hintData.difficulty.maxDifficulty || "?"}`,
		);

		return combinedData;
	} catch (error) {
		console.error(`\n❌ Error:`, error);
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

export { scrapeAndSave, fetchAnswer, fetchHintsDirectly };