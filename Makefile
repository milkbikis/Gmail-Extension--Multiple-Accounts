src.zip: src/* src/css/* src/images/*
	vim src/manifest.json
	zip src.zip -x \*.swp -r src/
	open https://chrome.google.com/webstore/developer/edit/mcpnehokodklgijkcakcfmccgpanipfp

upload:
	open https://chrome.google.com/webstore/developer/edit/mcpnehokodklgijkcakcfmccgpanipfp
