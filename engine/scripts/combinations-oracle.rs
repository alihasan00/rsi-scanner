use crypto_server::{model::Candle,live_luxalgo,screener,luxalgo::{breakouts,extended,indicators}};
use serde_json::{Value,json};
use std::{fs,collections::BTreeMap};
fn main() {
 let cases:Vec<Value>=serde_json::from_slice(&fs::read("reports/combo-paper-activation-2026-09-30/live-parity-cases.json").unwrap()).unwrap();
 let mut counts=BTreeMap::new();let mut data:BTreeMap<String,Vec<Candle>>=BTreeMap::new();let mut out=vec![];
 for c in cases {let method=c["method"].as_str().unwrap();let expected=c["expected"].as_bool().unwrap();let key=format!("{method}:{expected}");if *counts.get(&key).unwrap_or(&0)>=8 {continue};let file=c["file"].as_str().unwrap();
 let bars=data.entry(file.into()).or_insert_with(||fs::read_to_string(file).unwrap().lines().map(|line| {let f:Vec<_>=line.split(',').collect();Candle{open_time:f[0].parse().unwrap(),close_time:f[1].parse().unwrap(),open:f[2].parse().unwrap(),high:f[3].parse().unwrap(),low:f[4].parse().unwrap(),close:f[5].parse().unwrap(),volume:f[6].parse().unwrap()}}).collect());
 let index=c["index"].as_u64().unwrap() as usize;let frame=c["frame"].as_str().unwrap();let size=if frame=="15m" {999} else {500};let start=(c["start"].as_u64().unwrap() as usize).max((index+1).saturating_sub(size));let b=&bars[start..=index];let symbol=c["symbol"].as_str().unwrap();
 let entries=if frame=="4h" {screener::screen_with_gap_warmup(symbol,frame,"market",b,b.last().unwrap().close_time+1,false).unwrap()} else {live_luxalgo::entries(symbol,frame,b,b.last().unwrap().close_time+1)};
 let found=entries.iter().find(|e|e.method==method);if found.is_some()!=expected {continue};
 let helpers=if frame=="1d" {json!({"trendlines":breakouts::trendline_breakouts(b),"cluster":extended::supertrend_cluster(b),"sfp":breakouts::swing_failure(b)})} else if frame=="15m" {json!({"nwe":extended::nwe_endpoint(b),"ultimate":indicators::ultimate_rsi(b)})} else {json!({})};
 out.push(json!({"symbol":symbol,"frame":frame,"method":method,"expected":expected,"candles":b,"entry":found,"events":helpers,"source":{"file":file,"start":start,"index":index}}));*counts.entry(key).or_insert(0)+=1;
 }
 fs::write("/private/tmp/rsi-combo-fixtures.json",serde_json::to_vec(&out).unwrap()).unwrap();println!("{:?}",counts);
}
