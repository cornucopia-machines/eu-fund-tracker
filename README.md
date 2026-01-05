This is deployed via CloudFlare Workers to

- https://eu-fund-tracker-crawler.lorant-pinter.workers.dev
- https://eu-fund-tracker-processor.lorant-pinter.workers.dev

It scrapes EU funding opportunities from the EU Funding & Tenders Portal and posts new opportunities directly to Discord via webhook using a queue-based architecture with three independent modules (Crawler, Summarizer, Notifier).

## Development

You can trigger each module via HTTP request with a `/run-once` endpoint.
