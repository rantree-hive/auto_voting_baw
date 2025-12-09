# 🐋 Multi-Account Hive Auto-Voter (Flexible .env Support)

This repository contains a Node.js script (`voting.js`) that:

✔ Reads **any number of accounts** dynamically from a `.env` file  
✔ Uses the **Hive blockchain** (`@hiveio/dhive`) to vote on a target author  
✔ Votes on the **latest post + its comments**  
✔ Stops voting if the account's VP goes below a threshold  
✔ Automatically waits between votes and between accounts  

---

## 📁 Repository Structure

```text
hive-multi-voter/
│
├── voting.js
├── .env.example
├── package.json
└── README.md
```



---

## 🔧 1. Installation

```bash
git clone https://github.com/yourname/hive-multi-voter.git
cd hive-multi-voter

npm install @hiveio/dhive dotenv

🔐 2. .env Example (supports unlimited accounts)

Create a file named .env:

TARGET_AUTHOR=buildawhale
MIN_VOTING_POWER=8000
VOTE_WEIGHT=10000
HOURS_BACK=24
DELAY_BETWEEN_ACCOUNTS=5000
DELAY_BETWEEN_VOTES=3000

ACCOUNT_1_USERNAME="your user name"
ACCOUNT_1_POSTING_KEY="your private key"

ACCOUNT_2_USERNAME="your user name"
ACCOUNT_2_POSTING_KEY="your private key"

ACCOUNT_3_USERNAME="your user name"
ACCOUNT_3_POSTING_KEY="your private key"

ACCOUNT_4_USERNAME=antiabuse18
ACCOUNT_4_POSTING_KEY="your private key"


To add more accounts, simply continue:

ACCOUNT_5_USERNAME="..."
ACCOUNT_5_POSTING_KEY="..."


▶️ 3. Running the Script
node voting.js
