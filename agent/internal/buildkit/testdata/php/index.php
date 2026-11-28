<?php
// Built by real_samples_test.go with Railpack and Nixpacks (ADR 0030).
$greeting = getenv('GREETING') ?: 'hello';
echo htmlspecialchars($greeting), " from the shipkeep build test\n";
