declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}

// Allow importing raw HTML fixtures via Vite ?raw query suffix in tests
declare module '*.html?raw' {
	const content: string;
	export default content;
}
