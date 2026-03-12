# SkyStream CLI

The official command-line toolkit for building, testing, and managing SkyStream (Gen 2) plugin repositories.

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

### Build for Distribution

```bash
skystream build -u https://my-cdn.com/repo
```

## 🛠 Commands

| Command | Description |
| --- | --- |
| `init` | Initialize a Sky Gen 2 Repository project |
| `add` | Add a new plugin to the repository |
| `validate` | Validate all plugins in the repo |
| `test` | Test a specific plugin in a mock runtime |
| `build` | Bundle plugins and generate `repo.json` |

## 📖 Learn More
Visit the [SkyStream Repository Specification](https://github.com/akashdh11/skystream) for more details.
