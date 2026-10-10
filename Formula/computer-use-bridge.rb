# Updated by .github/workflows/release.yml when a v* tag is pushed.
class ComputerUseBridge < Formula
  desc "Let MCP clients use your Mac's apps and browser tabs over your tailnet"
  homepage "https://github.com/hank-warren/computer-use-bridge"
  url "https://github.com/hank-warren/computer-use-bridge/archive/refs/tags/v0.5.0.tar.gz"
  sha256 "ee2c88848bd0710e1ee85acaf990178fad007ab6cd95536e67c009f656b550f1"
  license "MIT"
  head "https://github.com/hank-warren/computer-use-bridge.git", branch: "main"

  depends_on :macos
  depends_on "node"

  def install
    libexec.install "computer-use-bridge.mjs"
    (bin/"computer-use-bridge").write <<~SH
      #!/bin/bash
      exec "#{formula_opt_bin("node")}/node" "#{opt_libexec}/computer-use-bridge.mjs" "$@"
    SH
  end

  def caveats
    <<~EOS
      Install the engines it drives, then grant open-computer-use its permissions:
        npm i -g open-computer-use open-browser-use
        open-computer-use
      For browser tabs (Brave or Chrome), register the native host and add the extension:
        open-browser-use install-manifest --browser chrome
      Configure the server and start it:
        computer-use-bridge setup
      Upgrade and restart the service in one step:
        computer-use-bridge update
    EOS
  end

  service do
    run [opt_bin/"computer-use-bridge", "serve"]
    keep_alive true
    environment_variables PATH: std_service_path_env
    process_type :interactive
    log_path var/"log/computer-use-bridge.log"
    error_log_path var/"log/computer-use-bridge.log"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/computer-use-bridge --version")
  end
end
