export type ChatMessage = {
	role: "system" | "user" | "assistant";
	content: string;
};

export type ChatCompletionRequest = {
	baseUrl: string;
	model: string;
	messages: ChatMessage[];
	apiKey?: string;
	temperature?: number;
};

type ChatCompletionResponse = {
	choices?: Array<{
		message?: {
			content?: string;
		};
	}>;
};

export async function createChatCompletion(
	request: ChatCompletionRequest,
	fetcher: typeof fetch = fetch,
): Promise<string> {
	const endpoint = `${request.baseUrl.replace(/\/+$/, "").replace(/\/chat\/completions$/, "")}/chat/completions`;
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};

	if (request.apiKey?.trim()) {
		headers.Authorization = `Bearer ${request.apiKey.trim()}`;
	}

	const response = await fetcher(endpoint, {
		method: "POST",
		headers,
		body: JSON.stringify({
			model: request.model,
			messages: request.messages,
			...(request.temperature === undefined ? {} : { temperature: request.temperature }),
		}),
	});

	const responseBody = await response.text();
	if (!response.ok) {
		throw new Error(`OpenAI-compatible API request failed (${response.status}): ${responseBody}`);
	}

	let data: ChatCompletionResponse;
	try {
		data = JSON.parse(responseBody) as ChatCompletionResponse;
	} catch {
		throw new Error("OpenAI-compatible API returned invalid JSON");
	}

	const content = data.choices?.[0]?.message?.content;
	if (!content) {
		throw new Error("OpenAI-compatible API returned no assistant message");
	}

	return content;
}