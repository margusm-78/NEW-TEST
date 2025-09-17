// test-profitable.ts - Updated test script
import { ethers } from "ethers";

// Import from the clean version
async function importBot() {
  try {
    const bot = await import("./src/searcher/profitable");
    return bot;
  } catch (error) {
    console.log("Import failed, trying alternative path...");
    try {
      const bot = await import("./profitable");
      return bot;
    } catch (error2) {
      console.log("Both import paths failed:", error, error2);
      throw error2;
    }
  }
}

async function testBot() {
  console.log("TESTING PROFITABLE MEV BOT");
  console.log("===========================");

  const bot = await importBot();
  const { runProfitableMEVBot, startContinuousMonitoring, CFG, ADDR } = bot;

  // Setup provider
  const rpcUrl = process.env.ARB_RPC_URL || "https://arb1.arbitrum.io/rpc";
  const provider = new ethers.JsonRpcProvider(rpcUrl);

  try {
    // Test connection
    console.log("Testing RPC connection...");
    const blockNumber = await provider.getBlockNumber();
    console.log(`Connected to Arbitrum, block: ${blockNumber}`);

    // Show configuration
    console.log("\nConfiguration:");
    console.log(`  Trade Size: ${ethers.formatUnits(CFG.PROBE_NOTIONAL_A, 18)} ARB`);
    console.log(`  Min Profit: ${ethers.formatUnits(CFG.MIN_PROFIT_ARB, 18)} ARB`);
    console.log(`  Cross-DEX: ${CFG.ENABLE_CROSS_DEX}`);
    console.log(`  Triangular: ${CFG.ENABLE_TRIANGULAR}`);

    console.log("\nAddresses:");
    console.log(`  ARB: ${ADDR.ARB}`);
    console.log(`  WETH: ${ADDR.WETH}`);
    console.log(`  Quoter: ${ADDR.UNI_QUOTER}`);

    const mode = process.argv[2] || "single";

    if (mode === "single" || mode === "test") {
      console.log("\nRunning single scan...");
      
      const startTime = Date.now();
      const result = await runProfitableMEVBot(provider);
      const duration = Date.now() - startTime;

      console.log(`\nScan completed in ${duration}ms`);
      
      if (result && result.profitable) {
        console.log("PROFITABLE OPPORTUNITY FOUND!");
        console.log("Strategy:", result.strategy);
        console.log("Profit:", result.profit ? ethers.formatUnits(result.profit, 18) + " ARB" : "Unknown");
        if (result.path) console.log("Path:", result.path);
      } else {
        console.log("No profitable opportunities found");
        console.log("\nTry these adjustments:");
        console.log("  PROBE_NOTIONAL_A=0.02");
        console.log("  MIN_PROFIT_ARB=0.001");
      }

    } else if (mode === "monitor") {
      console.log("\nStarting continuous monitoring...");
      await startContinuousMonitoring(provider);
      
    } else if (mode === "validate") {
      console.log("\nRunning validation tests...");
      
      const tests = [
        {
          name: "Quoter Contract",
          test: async () => {
            const code = await provider.getCode(ADDR.UNI_QUOTER);
            return code !== "0x" && code.length > 2;
          }
        },
        {
          name: "ARB/WETH Pool",
          test: async () => {
            const code = await provider.getCode(ADDR.UNIV3_ARB_WETH_03);
            return code !== "0x" && code.length > 2;
          }
        }
      ];

      for (const test of tests) {
        try {
          console.log(`   Testing: ${test.name}...`);
          const result = await test.test();
          console.log(`   ${result ? "PASS" : "FAIL"} - ${test.name}`);
        } catch (error) {
          console.log(`   ERROR - ${test.name}: ${error}`);
        }
      }
      
    } else {
      console.log("\nUsage:");
      console.log("  single/test - Run one scan");
      console.log("  monitor - Continuous monitoring");
      console.log("  validate - Run validation tests");
    }

  } catch (error) {
    console.log("Test failed:", error);
    process.exit(1);
  }
}

if (require.main === module) {
  testBot().catch(error => {
    console.error("Test script failed:", error);
    process.exit(1);
  });
}

export { testBot };log("🎉 PROFITABLE OPPORTUNITY FOUND!");
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log("❌ No profitable opportunities found");
        console.log("\n💡 Try these adjustments:");
        console.log("   - Increase trade size: PROBE_NOTIONAL_A=0.02");
        console.log("   - Lower profit threshold: MIN_PROFIT_ARB=0.001");
        console.log("   - Wait for higher market volatility");
      }

    } else if (mode === "monitor" || mode === "continuous") {
      console.log("\n🔄 Starting continuous monitoring...");
      console.log("Press Ctrl+C to stop");
      
      await startContinuousMonitoring(provider);
      
    } else if (mode === "validate") {
      console.log("\n🧪 Running validation tests...");
      
      // Test basic functionality
      const tests = [
        {
          name: "ARB Balance Check",
          test: async () => {
            const balance = await provider.getBalance("0x912CE59144191C1204E64559FE8253a0e49E6548");
            return balance > 0n;
          }
        },
        {
          name: "Quoter Contract Check", 
          test: async () => {
            const code = await provider.getCode(ADDR.UNI_QUOTER);
            return code !== "0x" && code.length > 2;
          }
        },
        {
          name: "Pool Contract Check",
          test: async () => {
            const code = await provider.getCode(ADDR.UNIV3_ARB_WETH_03);
            return code !== "0x" && code.length > 2;
          }
        }
      ];

      for (const test of tests) {
        try {
          console.log(`   Testing: ${test.name}...`);
          const result = await test.test();
          console.log(`   ${result ? "✅" : "❌"} ${test.name}: ${result ? "PASS" : "FAIL"}`);
        } catch (error) {
          console.log(`   💥 ${test.name}: ERROR - ${error}`);
        }
      }

    } else {
      console.log("\n❓ Unknown mode. Available modes:");
      console.log("   single/test - Run one scan");
      console.log("   monitor/continuous - Run continuous monitoring");
      console.log("   validate - Run validation tests");
      process.exit(1);
    }

  } catch (error) {
    console.log("💥 Test failed:", error);
    process.exit(1);
  }
}

// Handle CLI arguments and run
if (require.main === module) {
  testBot().then(() => {
    if (process.argv[2] !== "monitor" && process.argv[2] !== "continuous") {
      process.exit(0);
    }
  }).catch(error => {
    console.error("Test script failed:", error);
    process.exit(1);
  });
}

export { testBot };