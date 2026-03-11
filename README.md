<!-- AUTO-GENERATED README — DO NOT EDIT. Changes will be overwritten on next publish. -->
# claude-code-plugin-royalmail

Royal Mail Click & Drop shipping labels via browser automation

![Version](https://img.shields.io/badge/version-1.0.6-blue) ![License: MIT](https://img.shields.io/badge/License-MIT-green) ![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)

## Features

- **create-label** — Login and fill label form (does NOT submit)
- **submit** — Submit the filled form (after user confirmation)
- **download-label** — Download the generated PDF label
- **download-invoices** — Download new invoice PDFs (with dedupe + optional migration)
- **list-services** — Show available Royal Mail services
- **screenshot** — Take screenshot of current page
- **reset** — Close browser and clear session

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- API credentials for the target service (see Configuration)

## Quick Start

```bash
git clone https://github.com/bigl34/claude-code-plugin-royalmail.git
cd claude-code-plugin-royalmail
cp config.template.json config.json  # fill in your credentials
cd scripts && npm install
```

```bash
node scripts/dist/cli.js create-label
```

## Installation

1. Clone this repository
2. Copy `config.template.json` to `config.json` and fill in your credentials
3. Install dependencies:
   ```bash
   cd scripts && npm install
   ```

## Configuration

Copy `config.template.json` to `config.json` and fill in the required values:

| Field | Placeholder |
|-------|-------------|
| `credentials_path` | `/path/to/your/credentials` |

## Available Commands

### Available CLI Commands

| Command             | Purpose                                                      |
| ------------------- | ------------------------------------------------------------ |
| `create-label`      | Login and fill label form (does NOT submit)                  |
| `submit`            | Submit the filled form (after user confirmation)             |
| `download-label`    | Download the generated PDF label                             |
| `download-invoices` | Download new invoice PDFs (with dedupe + optional migration) |
| `list-services`     | Show available Royal Mail services                           |
| `screenshot`        | Take screenshot of current page                              |
| `reset`             | Close browser and clear session                              |

### create-label Options

| Option        | Required | Description                                     |
| ------------- | -------- | ----------------------------------------------- |
| `--name`      | Yes      | Recipient full name                             |
| `--address1`  | Yes      | Address line 1                                  |
| `--city`      | Yes      | City/town                                       |
| `--postcode`  | Yes      | UK postcode                                     |
| `--weight`    | Yes      | Weight in kg                                    |
| `--service`   | Yes      | Service code (see Service Codes below)          |
| `--company`   | No       | Company name                                    |
| `--address2`  | No       | Address line 2                                  |
| `--email`     | No       | Recipient email                                 |
| `--phone`     | No       | Recipient phone                                 |
| `--reference` | No       | Customer reference (e.g., Shopify order number) |
| `--contents`  | No       | Package contents description                    |

### download-invoices Options

| Option         | Required | Description                                          |
| -------------- | -------- | ---------------------------------------------------- |
| `--output-dir` | Yes      | Absolute destination for invoice PDFs                |
| `--legacy-dir` | No       | Legacy folder to migrate old invoices from           |
| `--headed`     | No       | Run browser in headed mode for selector/debug checks |

## Usage Examples

```bash
node scripts/dist/cli.js create-label \
  --name "Jane Doe" \
  --address1 "456 Oxford Street" \
  --city "London" \
  --postcode "W1D 1BS" \
  --weight 3 \
  --service SPECIALDELIVERY1 \
  --reference "ORD-67890"
```

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
