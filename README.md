<!-- AUTO-GENERATED README — DO NOT EDIT. Changes will be overwritten on next publish. -->
# claude-code-plugin-royalmail

Royal Mail Click & Drop shipping labels via browser automation

![Version](https://img.shields.io/badge/version-1.3.0-blue) ![License: MIT](https://img.shields.io/badge/License-MIT-green) ![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)

## Features

- CLI
- **purchase-label --request-file <private.json> --confirm** — Adopt/import or create one Click & Drop order, buy postage, download and validate its label
- **reconcile-purchase --run-id <id>** — Recover an already-paid uncertain run; never enters checkout or makes payment
- **list-services** — Return the supported service catalogue in operational order
- **download-invoices** — Download new invoice PDFs with dedupe
- **create-label** — Legacy browser preview only; does not submit
- **submit** — Compatibility refusal; does not submit
- **download-label** — Legacy session download
- **screenshot** — Diagnostic screenshot
- **reset** — Clear the legacy browser session

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- API credentials for the target service (see Configuration)

## Quick Start

```bash
git clone https://github.com/bigl34/claude-code-plugin-royalmail.git
cd claude-code-plugin-royalmail
cp config.template.json config.json  # fill in your credentials
npm --prefix scripts install
```

```bash
npm --prefix scripts run cli -- purchase-label --request-file <private.json> --confirm
```

## Installation

1. Clone this repository
2. Copy `config.template.json` to `config.json` and fill in your credentials
3. Install dependencies:
   ```bash
   cd scripts && npm install
   ```

## Available Commands

| Command                                                  | Purpose                                                                                     |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `purchase-label --request-file <private.json> --confirm` | Adopt/import or create one Click & Drop order, buy postage, download and validate its label |
| `reconcile-purchase --run-id <id>`                       | Recover an already-paid uncertain run; never enters checkout or makes payment               |
| `list-services`                                          | Return the supported service catalogue in operational order                                 |
| `download-invoices`                                      | Download new invoice PDFs with dedupe                                                       |
| `create-label`                                           | Legacy browser preview only; does not submit                                                |
| `submit`                                                 | Compatibility refusal; does not submit                                                      |
| `download-label`                                         | Legacy session download                                                                     |
| `screenshot`                                             | Diagnostic screenshot                                                                       |
| `reset`                                                  | Clear the legacy browser session                                                            |

## How It Works

This plugin connects directly to the service's HTTP API. The CLI handles authentication, request formatting, pagination, and error handling, returning structured JSON responses.

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Authentication errors | Verify credentials in `config.json` |
| `ERR_MODULE_NOT_FOUND` | Run `cd scripts && npm install` |
| Rate limiting | The CLI handles retries automatically; wait and retry if persistent |
| Unexpected JSON output | Check API credentials haven't expired |

## Contributing

Issues and pull requests are welcome.

## License

MIT
