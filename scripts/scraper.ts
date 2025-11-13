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
		definition: string[] | null;
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
				"NYTimes 6.0/127204.251031 CFNetwork/3860.200.71 Darwin/25.1.0",
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

function extractDefinition(text: string): string[] | null {
	const patterns = [
		/it could refer to (.+?)\.?$/i,
		/it means (.+?)\.?$/i,
		/it could mean (.+?)\.?$/i,
	];

	for (const pattern of patterns) {
		const match = text.match(pattern);
		if (match?.[1]) {
			const fullText = match[1].trim();

			const definitions = fullText
				.match(/\u201C([^\u201C\u201D]+)\u201D?/g)
				?.map((def) => {
					let cleaned = def
						.trim()
						.replace(/^\u201C|\u201D$/g, "")
						.trim();

					while (
						cleaned.length > 0 &&
						!/[a-zA-Z]/.test(cleaned.charAt(cleaned.length - 1))
					) {
						cleaned = cleaned.slice(0, -1);
					}

					return cleaned;
				})
				.filter((def) => def.length > 0);

			return definitions && definitions.length > 0 ? definitions : null;
		}
	}

	return null;
}

async function fetchHintsDirectly(hintsUrl: string): Promise<HintResponse> {
	console.log(`Fetching hints from: ${hintsUrl}`);

	const browser = await chromium.launch({
		headless: true,
		args: ["--no-sandbox", "--disable-setuid-sandbox"],
	});

	let page;

	try {
		const context = await browser.newContext({
			userAgent:
				"NYTimes 6.0/127204.251031 CFNetwork/3860.200.71 Darwin/25.1.0",
			viewport: { width: 390, height: 844 },
			deviceScaleFactor: 3,
			isMobile: true,
			hasTouch: true,
		});

		page = await context.newPage();

		console.log("Navigating to page...");

		try {
			await page.goto(hintsUrl, {
				waitUntil: "domcontentloaded",
				timeout: 60000,
			});
		} catch (error) {
			console.log("Navigation error:", error);
			throw error;
		}

		console.log("Page loaded, checking for verification screen...");

		await page.waitForTimeout(2000);

		const bodyText = await page.textContent("body").catch(() => "");
		const hasVerification =
			bodyText?.includes("Thank you for your patience") ||
			bodyText?.includes("verify access") ||
			bodyText?.includes("captcha-delivery") ||
			bodyText?.includes("DataDome");

		if (hasVerification) {
			console.log(
				"Verification screen detected, starting human-like scrolling...",
			);

			let attempts = 0;
			const maxAttempts = 60;
			let scrollingDown = true;

			while (attempts < maxAttempts) {
				if (scrollingDown) {
					console.log("Scrolling to bottom...");
					await page.evaluate(() => {
						window.scrollTo({
							top: document.body.scrollHeight,
							left: 0,
							behavior: "smooth",
						});
					});
					await page.waitForTimeout(2000);
					scrollingDown = false;
				} else {
					console.log("Scrolling to top...");
					await page.evaluate(() => {
						window.scrollTo({
							top: 0,
							left: 0,
							behavior: "smooth",
						});
					});
					await page.waitForTimeout(2000);
					scrollingDown = true;
				}

				attempts += 2;

				const currentBody = await page.textContent("body").catch(() => "");
				const stillVerifying =
					currentBody?.includes("Thank you for your patience") ||
					currentBody?.includes("verify access") ||
					currentBody?.includes("captcha-delivery") ||
					currentBody?.includes("DataDome");

				if (!stillVerifying) {
					console.log(`Verification cleared after ${attempts} seconds`);
					break;
				}

				console.log(`Still waiting... (${attempts}s)`);
			}

			if (attempts >= maxAttempts) {
				throw new Error("Verification screen did not clear after 60 seconds");
			}
		} else {
			console.log("No verification screen detected");
		}

		console.log("Waiting for content to fully load...");
		await page.waitForTimeout(3000);

		const finalBody = await page.textContent("body").catch(() => "");
		if (
			finalBody?.includes("captcha-delivery") ||
			finalBody?.includes("DataDome")
		) {
			console.log("Still blocked by DataDome");
			throw new Error("Still blocked by DataDome");
		}

		console.log("Getting page HTML...");
		const html = await page.content();

		await Bun.write("debug-hints.html", html);
		console.log("Saved HTML to debug-hints.html");

		const $ = cheerio.load(html);

		console.log("\nExtracting data...");

		let consonant = "";
		let vowel = "";
		let dictionaryName: string | null = null;
		let definition: string[] | null = null;

		const revealBlocks = $('[data-testid="reveal-block"]');
		console.log(`Found ${revealBlocks.length} reveal blocks`);

		if (revealBlocks.length === 0) {
			console.log("No reveal blocks found! Saving debug HTML for inspection.");
			console.log(
				"First 500 chars of body:",
				$("body").text().substring(0, 500),
			);
		}

		revealBlocks.each((i, block) => {
			const $block = $(block);
			const buttonText = $block
				.find('[role="button"] p')
				.text()
				.trim()
				.toLowerCase();

			console.log(`Block ${i + 1}: "${buttonText}"`);

			if (buttonText.includes("consonant") && !consonant) {
				const fullText = $block
					.find(".show, .css-wndcfh")
					.text()
					.trim()
					.toUpperCase();
				const cleanText = fullText.replace(/GIVE ME A CONSONANT/gi, "").trim();
				consonant =
					cleanText.charAt(cleanText.length - 1) || cleanText.charAt(0);
				console.log(`  Consonant: ${consonant}`);
			} else if (buttonText.includes("vowel") && !vowel) {
				const fullText = $block
					.find(".show, .css-wndcfh")
					.text()
					.trim()
					.toUpperCase();
				const cleanText = fullText.replace(/GIVE ME A VOWEL/gi, "").trim();
				vowel = cleanText.charAt(cleanText.length - 1) || cleanText.charAt(0);
				console.log(`  Vowel: ${vowel}`);
			} else if (buttonText.includes("reveal") && !definition) {
				const paragraphs = $block.find(".show p, .css-wndcfh p");

				paragraphs.each((_, p) => {
					const text = $(p).text().trim();

					if (text.includes("According to") && !dictionaryName) {
						const link = $(p).find("a");
						if (link.length > 0) {
							const linkText = link.text().trim();
							dictionaryName = linkText;
							console.log(`  Dictionary: ${dictionaryName}`);
						}
					}

					if (text.length > 50 && !definition) {
						const extractedDef = extractDefinition(text);
						if (extractedDef) {
							definition = extractedDef;
							console.log(`  Definition: ${JSON.stringify(definition)}`);
						}
					}
				});
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

		console.log(`Difficulty text: "${difficultyText}"`);

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

		console.log(`Consonant: ${consonant || "NOT FOUND"}`);
		console.log(`Vowel: ${vowel || "NOT FOUND"}`);
		console.log(`Dictionary: ${dictionaryName || "NOT FOUND"}`);
		console.log(`Definition: ${definition ? "FOUND" : "NOT FOUND"}`);

		return {
			hint: { consonant, vowel },
			difficulty: { difficulty, maxDifficulty, text: friendlyText },
			details: {
				definition,
				source: { name: dictionaryName, url: hintsUrl },
			},
		};
	} catch (error) {
		console.log("Error in fetchHintsDirectly:", error);
		throw error;
	} finally {
		console.log("Closing browser...");
		await browser.close();
	}
}

async function scrapeAndSave(timestamp?: number) {
	const ts = timestamp || Date.now();
	const date = new Date(ts);
	const dateStr = date.toISOString().split("T")[0];

	console.log(`\nScraping Wordle for ${dateStr}...\n`);

	try {
		const wordleData = await fetchAnswer(ts);

		if (wordleData.error) {
			throw new Error("Failed to fetch Wordle data");
		}

		console.log(`\nGot answer: ${wordleData.solution.toUpperCase()}`);
		console.log(`Puzzle #${wordleData.days_since_launch}\n`);

		const hintDate = new Date(ts);
		hintDate.setDate(hintDate.getDate() - 1);

		const year = hintDate.getFullYear();
		const month = String(hintDate.getMonth() + 1).padStart(2, "0");
		const day = String(hintDate.getDate()).padStart(2, "0");

		const hintsUrl = `https://www.nytimes.com/${year}/${month}/${day}/crosswords/wordle-review-${wordleData.days_since_launch}.html`;

		const hintData = await fetchHintsDirectly(hintsUrl);

		// Only save hintData with scrapedAt
		const outputData = {
			...hintData,
			scrapedAt: Date.now(),
		};

		const dataDir = `${process.cwd()}/data`;
		const filePath = `${dataDir}/${dateStr}.json`;

		await Bun.write(filePath, JSON.stringify(outputData, null, 2));

		console.log(`\nSuccess!`);
		console.log(`File: ${filePath}`);
		console.log(`Puzzle #${wordleData.days_since_launch}`);
		console.log(`Consonant: ${hintData.hint.consonant || "NOT FOUND"}`);
		console.log(`Vowel: ${hintData.hint.vowel || "NOT FOUND"}`);
		console.log(
			`Difficulty: ${hintData.difficulty.difficulty || "NOT FOUND"}/${hintData.difficulty.maxDifficulty || "?"}`,
		);

		return outputData;
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

export { scrapeAndSave, fetchAnswer, fetchHintsDirectly };
