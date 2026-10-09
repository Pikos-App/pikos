use super::description_text;

#[test]
fn plain_text_is_left_alone_even_with_angle_brackets_and_ampersands() {
    let plain = "Bring <passport> & adapters\nseats 14A & 14B";
    assert_eq!(description_text(plain), plain);
}

#[test]
fn line_breaks_and_entities_become_text() {
    assert_eq!(
        description_text("Packing &amp; logistics<br>Line two<br/>Line three<br />&lt;ok&gt; &quot;q&quot; &#39;a&#39; &#x2192;"),
        "Packing & logistics\nLine two\nLine three\n<ok> \"q\" 'a' →"
    );
}

#[test]
fn formatting_tags_drop_and_keep_their_text() {
    assert_eq!(
        description_text(
            "<b>bold</b>, <i>italic</i>, <u>under</u><u></u> and <span>plain</span>&amp;"
        ),
        "bold, italic, under and plain&"
    );
}

#[test]
fn paragraphs_and_list_items_end_their_lines() {
    assert_eq!(
        description_text("<p>One</p><div>Two</div><ul><li>a</li><li>b</li></ul>"),
        "One\nTwo\n- a\n- b\n"
    );
}

#[test]
fn a_link_keeps_its_text_and_an_address_the_text_does_not_show() {
    assert_eq!(
        description_text(
            r#"See <a href="https://pikos.app/speed">the numbers</a><br><a href="https://pikos.app">https://pikos.app</a>"#
        ),
        "See the numbers (https://pikos.app/speed)\nhttps://pikos.app"
    );
}

#[test]
fn an_unclosed_bracket_or_unknown_entity_stays_as_written() {
    assert_eq!(
        description_text("a &amp; b < c &bogus; d"),
        "a & b < c &bogus; d"
    );
}
