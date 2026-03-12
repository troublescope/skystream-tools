# SkyStream CLI

The official command-line toolkit for deploying, testing, and managing SkyStream (Gen 2) plugin repositories.

## 🚀 Quick Start

### Installation

```bash
npm install -g skystream-cli
```

### Initialize a new Repository

```bash
skystream init "My Universe" --package-name com.example.repo --plugin-name "Provider 1"
```

### Add a new Plugin

```bash
cd my-universe
skystream add "New Provider"
```

### Deploy for Distribution

```bash
skystream deploy -u https://my-cdn.com/repo
```

## 🛠 Commands

| Command | Description |
| --- | --- |
| `init` | Initialize a Sky Gen 2 Repository project |
| `add` | Add a new plugin to the repository |
| `validate` | Validate all plugins in the repo |
| `test` | Test a specific plugin in a mock runtime |
| `deploy` | Bundle plugins and generate `repo.json` |

## 📖 Learn More
Visit the [SkyStream Repository Specification](https://github.com/akashdh11/skystream) for more details.
